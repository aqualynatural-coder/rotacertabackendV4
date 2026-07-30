import { Router } from "express";
import { prisma } from "../lib/prisma";
import { authRequired } from "../middleware/auth";

const router = Router();
router.use(authRequired);

router.get("/", async (req, res, next) => {
  try {
    const list = await prisma.notification.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json(list);
  } catch (e) {
    next(e);
  }
});

router.post("/:id/read", async (req, res, next) => {
  try {
    const n = await prisma.notification.update({
      where: { id: req.params.id },
      data: { read: true },
    });
    res.json(n);
  } catch (e) {
    next(e);
  }
});

router.post("/read-all", async (req, res, next) => {
  try {
    await prisma.notification.updateMany({ where: { userId: req.user!.id }, data: { read: true } });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
