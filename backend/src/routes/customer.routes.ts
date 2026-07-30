import { Router } from "express";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { authRequired, requireRole } from "../middleware/auth";

const router = Router();
router.use(authRequired);

const customerSchema = z.object({
  name: z.string().min(2),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().min(3),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  latitude: z.number(),
  longitude: z.number(),
  notes: z.string().optional(),
});

router.get("/", async (_req, res, next) => {
  try {
    const list = await prisma.customer.findMany({ orderBy: { name: "asc" } });
    res.json(list);
  } catch (e) {
    next(e);
  }
});

router.post("/", requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    const data = customerSchema.parse(req.body);
    const c = await prisma.customer.create({ data });
    res.status(201).json(c);
  } catch (e) {
    next(e);
  }
});

router.patch("/:id", requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    const data = customerSchema.partial().parse(req.body);
    const c = await prisma.customer.update({ where: { id: req.params.id }, data });
    res.json(c);
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    await prisma.customer.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
