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
    const users = await prisma.user.findMany({
      select: { id: true, name: true, email: true, role: true, active: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(users);
  } catch (e) {
    next(e);
  }
});

const createSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.nativeEnum(Role),
});

router.post("/", requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    const data = createSchema.parse(req.body);
    const exists = await prisma.user.findUnique({ where: { email: data.email } });
    if (exists) throw new HttpError(409, "E-mail já cadastrado");
    const passwordHash = await bcrypt.hash(data.password, 12);
    const user = await prisma.user.create({
      data: { name: data.name, email: data.email, role: data.role, passwordHash },
      select: { id: true, name: true, email: true, role: true },
    });
    res.status(201).json(user);
  } catch (e) {
    next(e);
  }
});

router.patch("/:id", requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    const schema = z.object({
      name: z.string().optional(),
      active: z.boolean().optional(),
      password: z.string().min(6).optional(),
    });
    const data = schema.parse(req.body);
    const patch: any = { ...data };
    if (data.password) {
      patch.passwordHash = await bcrypt.hash(data.password, 12);
      delete patch.password;
    }
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: patch,
      select: { id: true, name: true, email: true, role: true, active: true },
    });
    res.json(user);
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
