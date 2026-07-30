import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import path from "path";
import fs from "fs";
import { Role, DeliveryStatus, RouteStatus, AlertType, FailureCode } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { authRequired, requireRole } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";
import { audit } from "../utils/audit";

const router = Router();
router.use(authRequired);

// Upload de foto
const uploadDir = path.resolve(process.env.UPLOAD_DIR ?? "./uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `proof-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Somente imagens são aceitas"));
    cb(null, true);
  },
});

// LIST
router.get("/", async (req, res, next) => {
  try {
    const where: any = {};
    if (req.user!.role === Role.DRIVER) {
      const d = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
      if (!d) return res.json([]);
      where.driverId = d.id;
    }
    if (req.query.status) where.status = req.query.status;

    const list = await prisma.delivery.findMany({
      where,
      include: {
        customer: true,
        proof: true,
        failure: true,
        route: { select: { id: true, name: true, status: true } },
      },
      orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
    });
    res.json(list);
  } catch (e) {
    next(e);
  }
});

// GET one
router.get("/:id", async (req, res, next) => {
  try {
    const d = await prisma.delivery.findUnique({
      where: { id: req.params.id },
      include: { customer: true, proof: true, failure: true, route: true, driver: { include: { user: true } } },
    });
    if (!d) throw new HttpError(404, "Entrega não encontrada");
    if (req.user!.role === Role.DRIVER) {
      const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
      if (!driver || d.driverId !== driver.id) throw new HttpError(403, "Acesso negado");
    }
    res.json(d);
  } catch (e) {
    next(e);
  }
});

// CREATE
const createSchema = z.object({
  customerId: z.string(),
  driverId: z.string().optional(),
  routeId: z.string().optional(),
  scheduledAt: z.string().datetime().optional(),
  notes: z.string().optional(),
  sequence: z.number().optional(),
});

router.post("/", requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    const data = createSchema.parse(req.body);
    const d = await prisma.delivery.create({
      data: {
        customerId: data.customerId,
        driverId: data.driverId,
        routeId: data.routeId,
        scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : null,
        notes: data.notes,
        sequence: data.sequence ?? 0,
        status: data.driverId ? DeliveryStatus.ASSIGNED : DeliveryStatus.PENDING,
      },
      include: { customer: true },
    });
    const io = req.app.get("io");
    if (data.driverId) io?.to(`driver:${data.driverId}`).emit("delivery:assigned", d);
    io?.to("admin").emit("delivery:created", d);
    await audit({ userId: req.user!.id, action: "DELIVERY_CREATED", entity: "Delivery", entityId: d.id });
    res.status(201).json(d);
  } catch (e) {
    next(e);
  }
});

// UPDATE
router.patch("/:id", requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    const schema = createSchema.partial().extend({ status: z.nativeEnum(DeliveryStatus).optional() });
    const data = schema.parse(req.body);
    const d = await prisma.delivery.update({
      where: { id: req.params.id },
      data: {
        ...data,
        scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : undefined,
      },
    });
    res.json(d);
  } catch (e) {
    next(e);
  }
});

// DELETE
router.delete("/:id", requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    await prisma.delivery.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// START (motorista inicia trânsito)
router.post("/:id/start", async (req, res, next) => {
  try {
    const d = await prisma.delivery.update({
      where: { id: req.params.id },
      data: { status: DeliveryStatus.IN_TRANSIT },
      include: { customer: true },
    });
    if (d.routeId) {
      await prisma.route.update({
        where: { id: d.routeId },
        data: { status: RouteStatus.ACTIVE, startedAt: new Date() },
      }).catch(() => null);
    }
    const io = req.app.get("io");
    io?.emit("delivery:started", d);
    res.json(d);
  } catch (e) {
    next(e);
  }
});

// ARRIVE
router.post("/:id/arrive", async (req, res, next) => {
  try {
    const schema = z.object({
      latitude: z.number(),
      longitude: z.number(),
    });
    const { latitude, longitude } = schema.parse(req.body);
    const d = await prisma.delivery.update({
      where: { id: req.params.id },
      data: {
        status: DeliveryStatus.ARRIVED,
        arrivedAt: new Date(),
        arrivedLat: latitude,
        arrivedLng: longitude,
      },
      include: { customer: true, driver: { include: { user: true } } },
    });
    const io = req.app.get("io");
    io?.emit("delivery:arrived", d);
    // Notifica admin
    const admins = await prisma.user.findMany({ where: { role: Role.ADMIN } });
    for (const a of admins) {
      await prisma.notification.create({
        data: {
          userId: a.id,
          type: AlertType.NEW_DELIVERY,
          title: "Motorista chegou ao cliente",
          body: `${d.driver?.user.name ?? "Motorista"} chegou em ${d.customer.name}`,
          data: { deliveryId: d.id },
        },
      });
    }
    await audit({ userId: req.user!.id, action: "DELIVERY_ARRIVED", entity: "Delivery", entityId: d.id });
    res.json(d);
  } catch (e) {
    next(e);
  }
});

// COMPLETE — foto de prova (multipart)
router.post("/:id/complete", upload.single("photo"), async (req, res, next) => {
  try {
    const schema = z.object({
      latitude: z.coerce.number(),
      longitude: z.coerce.number(),
      notes: z.string().optional(),
    });
    const { latitude, longitude, notes } = schema.parse(req.body);
    if (!req.file) throw new HttpError(400, "Foto de prova obrigatória");
    const photoUrl = `/uploads/${req.file.filename}`;

    const d = await prisma.delivery.update({
      where: { id: req.params.id },
      data: {
        status: DeliveryStatus.COMPLETED,
        completedAt: new Date(),
        notes: notes ?? undefined,
        proof: {
          create: { photoUrl, latitude, longitude, notes },
        },
      },
      include: { customer: true, proof: true, driver: { include: { user: true } } },
    });

    const io = req.app.get("io");
    io?.emit("delivery:completed", d);

    const admins = await prisma.user.findMany({ where: { role: Role.ADMIN } });
    for (const a of admins) {
      await prisma.notification.create({
        data: {
          userId: a.id,
          type: AlertType.DELIVERY_COMPLETED,
          title: "Entrega concluída",
          body: `${d.customer.name} — ${d.driver?.user.name ?? "Motorista"}`,
          data: { deliveryId: d.id, photoUrl },
        },
      });
    }

    await audit({ userId: req.user!.id, action: "DELIVERY_COMPLETED", entity: "Delivery", entityId: d.id });
    res.json(d);
  } catch (e) {
    next(e);
  }
});

// FAIL — POD obrigatório também em falha (multipart com foto)
router.post("/:id/fail", upload.single("photo"), async (req, res, next) => {
  try {
    const schema = z.object({
      code: z.nativeEnum(FailureCode),
      notes: z.string().optional(),
      latitude: z.coerce.number().optional(),
      longitude: z.coerce.number().optional(),
    });
    const parsed = schema.parse(req.body);
    // Foto obrigatória para comprovar a falha
    if (!req.file) throw new HttpError(400, "Foto obrigatória para comprovar a ocorrência");
    const photoUrl = `/uploads/${req.file.filename}`;
    const d = await prisma.delivery.update({
      where: { id: req.params.id },
      data: {
        status: DeliveryStatus.FAILED,
        completedAt: new Date(),
        failure: { create: { ...parsed, photoUrl } },
      },
      include: { customer: true, failure: true, driver: { include: { user: true } } },
    });
    const io = req.app.get("io");
    io?.emit("delivery:failed", d);

    const admins = await prisma.user.findMany({ where: { role: Role.ADMIN } });
    for (const a of admins) {
      await prisma.notification.create({
        data: {
          userId: a.id,
          type: AlertType.DELIVERY_FAILED,
          title: "Falha na entrega",
          body: `${d.customer.name} — ${d.failure?.code ?? ""}`,
          data: { deliveryId: d.id },
        },
      });
    }
    await audit({ userId: req.user!.id, action: "DELIVERY_FAILED", entity: "Delivery", entityId: d.id });
    res.json(d);
  } catch (e) {
    next(e);
  }
});

export default router;
