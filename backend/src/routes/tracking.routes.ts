// ============================================================
// Link público de rastreamento — cliente acompanha SEM login
// ============================================================
import { Router } from "express";
import crypto from "crypto";
import { Role } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { authRequired, requireRole } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";

const router = Router();

// ===== Admin: criar link para uma rota =====
router.post(
  "/routes/:routeId/links",
  authRequired,
  requireRole(Role.ADMIN),
  async (req, res, next) => {
    try {
      const route = await prisma.route.findUnique({ where: { id: req.params.routeId } });
      if (!route) throw new HttpError(404, "Rota não encontrada");
      const expiresHours = Math.min(168, Number(req.body?.expiresHours) || 48);
      const link = await prisma.trackingLink.create({
        data: {
          token: crypto.randomBytes(24).toString("hex"),
          routeId: route.id,
          expiresAt: new Date(Date.now() + expiresHours * 3600_000),
        },
      });
      res.status(201).json(link);
    } catch (e) {
      next(e);
    }
  }
);

// Admin: listar/desativar links de uma rota
router.get(
  "/routes/:routeId/links",
  authRequired,
  requireRole(Role.ADMIN),
  async (req, res, next) => {
    try {
      const links = await prisma.trackingLink.findMany({
        where: { routeId: req.params.routeId },
        orderBy: { createdAt: "desc" },
      });
      res.json(links);
    } catch (e) {
      next(e);
    }
  }
);

router.patch(
  "/links/:id/revoke",
  authRequired,
  requireRole(Role.ADMIN),
  async (req, res, next) => {
    try {
      const link = await prisma.trackingLink.update({
        where: { id: req.params.id },
        data: { active: false },
      });
      res.json(link);
    } catch (e) {
      next(e);
    }
  }
);

// ===== Público: dados da rota pelo token (SEM autenticação) =====
router.get("/t/:token", async (req, res, next) => {
  try {
    const link = await prisma.trackingLink.findUnique({
      where: { token: req.params.token },
      include: {
        route: {
          include: {
            driver: { include: { user: { select: { name: true } } } },
            deliveries: {
              include: { customer: { select: { name: true, address: true, latitude: true, longitude: true } } },
              orderBy: { sequence: "asc" },
            },
          },
        },
      },
    });
    if (!link || !link.active) throw new HttpError(404, "Link inválido ou revogado");
    if (link.expiresAt && link.expiresAt < new Date())
      throw new HttpError(410, "Link expirado");

    // Última posição conhecida do motorista nesta rota
    const lastPing = await prisma.locationPing.findFirst({
      where: { routeId: link.routeId },
      orderBy: { recordedAt: "desc" },
    });

    res.json({
      routeName: link.route.name,
      status: link.route.status,
      driverName: link.route.driver?.user.name ?? null,
      startedAt: link.route.startedAt,
      endedAt: link.route.endedAt,
      deliveries: link.route.deliveries.map((d) => ({
        sequence: d.sequence,
        status: d.status,
        customerName: d.customer.name,
        address: d.customer.address,
        latitude: d.customer.latitude,
        longitude: d.customer.longitude,
      })),
      lastPosition: lastPing
        ? { latitude: lastPing.latitude, longitude: lastPing.longitude, at: lastPing.recordedAt }
        : null,
      expiresAt: link.expiresAt,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
