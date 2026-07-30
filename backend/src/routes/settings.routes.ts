import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import path from "path";
import fs from "fs";
import { Role } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { authRequired, requireRole } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";
import { audit } from "../utils/audit";

const router = Router();

const uploadDir = path.resolve(process.env.UPLOAD_DIR ?? "./uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".png";
    cb(null, `logo-${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Somente imagens"));
    cb(null, true);
  },
});

// GET público das configurações (para o frontend aplicar cores/logo)
router.get("/public", async (_req, res, next) => {
  try {
    const s = await prisma.systemSettings.findUnique({ where: { id: "settings" } });
    res.json(s ?? { companyName: "RotaCerta", logoUrl: null, accentColor: "#0EA5E9" });
  } catch (e) {
    next(e);
  }
});

router.use(authRequired, requireRole(Role.ADMIN));

// GET completo
router.get("/", async (_req, res, next) => {
  try {
    const s = await prisma.systemSettings.findUnique({ where: { id: "settings" } });
    res.json(s);
  } catch (e) {
    next(e);
  }
});

// PATCH atualiza nome/cor
router.patch("/", async (req, res, next) => {
  try {
    const schema = z.object({
      companyName: z.string().min(1).optional(),
      accentColor: z.string().regex(/^#([0-9a-fA-F]{6})$/).optional(),
      hqAddress: z.string().optional().nullable(),
      hqLatitude: z.number().optional().nullable(),
      hqLongitude: z.number().optional().nullable(),
      hqRadiusM: z.number().min(30).max(2000).optional(),
    });
    const data = schema.parse(req.body);
    const s = await prisma.systemSettings.upsert({
      where: { id: "settings" },
      create: { id: "settings", ...data },
      update: data,
    });
    await audit({ userId: req.user!.id, action: "SETTINGS_UPDATED", entity: "SystemSettings", metadata: data });
    res.json(s);
  } catch (e) {
    next(e);
  }
});

// POST /logo — upload da logo da empresa
router.post("/logo", upload.single("logo"), async (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, "Arquivo de logo obrigatório");
    const logoUrl = `/uploads/${req.file.filename}`;
    const s = await prisma.systemSettings.upsert({
      where: { id: "settings" },
      create: { id: "settings", logoUrl },
      update: { logoUrl },
    });
    await audit({ userId: req.user!.id, action: "LOGO_UPDATED", entity: "SystemSettings" });
    res.json(s);
  } catch (e) {
    next(e);
  }
});

export default router;
