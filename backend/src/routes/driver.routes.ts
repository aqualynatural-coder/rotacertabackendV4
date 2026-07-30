import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { authRequired, requireRole } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";

const router = Router();
router.use(authRequired);

router.get("/", requireRole(Role.ADMIN), async (_req, res, next) => {
  try {
    const drivers = await prisma.driver.findMany({
      include: { user: { select: { id: true, name: true, email: true, active: true, avatarUrl: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(drivers);
  } catch (e) {
    next(e);
  }
});

const createSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().optional(),
  licenseNumber: z.string().optional(),
  vehiclePlate: z.string().optional(),
  vehicleModel: z.string().optional(),
});

router.post("/", requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    const data = createSchema.parse(req.body);
    const exists = await prisma.user.findUnique({ where: { email: data.email } });
    if (exists) throw new HttpError(409, "E-mail já cadastrado");
    const passwordHash = await bcrypt.hash(data.password, 12);
    const created = await prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        passwordHash,
        role: Role.DRIVER,
        driver: {
          create: {
            phone: data.phone,
            licenseNumber: data.licenseNumber,
            vehiclePlate: data.vehiclePlate,
            vehicleModel: data.vehicleModel,
          },
        },
      },
      include: { driver: true },
    });
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

router.get("/:id", requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    const driver = await prisma.driver.findUnique({
      where: { id: req.params.id },
      include: { user: true, deliveries: true, routes: true },
    });
    if (!driver) throw new HttpError(404, "Motorista não encontrado");
    res.json(driver);
  } catch (e) {
    next(e);
  }
});

router.patch("/:id", requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    const schema = z.object({
      phone: z.string().optional(),
      licenseNumber: z.string().optional(),
      vehiclePlate: z.string().optional(),
      vehicleModel: z.string().optional(),
    });
    const data = schema.parse(req.body);
    const driver = await prisma.driver.update({ where: { id: req.params.id }, data });
    res.json(driver);
  } catch (e) {
    next(e);
  }
});

export default router;
