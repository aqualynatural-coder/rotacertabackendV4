// ============================================================
// Exportações no servidor — CSV e PDF (relatórios oficiais)
// ============================================================
import { Router } from "express";
import PDFDocument from "pdfkit";
import { Role, DeliveryStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { authRequired, requireRole } from "../middleware/auth";

const router = Router();
router.use(authRequired, requireRole(Role.ADMIN));

const STATUS_PT: Record<string, string> = {
  PENDING: "Pendente", ASSIGNED: "Atribuída", IN_TRANSIT: "Em trânsito",
  ARRIVED: "No local", COMPLETED: "Concluída", FAILED: "Falha", CANCELED: "Cancelada",
};

async function queryDeliveries(from?: string, to?: string) {
  const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 86400_000);
  const toDate = to ? new Date(to) : new Date();
  return prisma.delivery.findMany({
    where: { createdAt: { gte: fromDate, lte: toDate } },
    include: {
      customer: true,
      driver: { include: { user: { select: { name: true } } } },
      route: { select: { name: true, distanceKm: true, fuelCostBrl: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

// GET /export/deliveries.csv
router.get("/deliveries.csv", async (req, res, next) => {
  try {
    const deliveries = await queryDeliveries(String(req.query.from ?? ""), String(req.query.to ?? ""));
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [
      ["Data", "Cliente", "Endereço", "Motorista", "Rota", "Status", "Chegada", "Conclusão"].map(esc).join(";"),
      ...deliveries.map((d) =>
        [
          d.createdAt.toLocaleString("pt-BR"),
          d.customer.name,
          d.customer.address,
          d.driver?.user.name ?? "—",
          d.route?.name ?? "—",
          STATUS_PT[d.status] ?? d.status,
          d.arrivedAt?.toLocaleString("pt-BR") ?? "",
          d.completedAt?.toLocaleString("pt-BR") ?? "",
        ].map(esc).join(";")
      ),
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="entregas-${Date.now()}.csv"`);
    res.send("﻿" + rows.join("\n")); // BOM p/ Excel pt-BR
  } catch (e) {
    next(e);
  }
});

// GET /export/report.pdf — relatório executivo do período
router.get("/report.pdf", async (req, res, next) => {
  try {
    const deliveries = await queryDeliveries(String(req.query.from ?? ""), String(req.query.to ?? ""));
    const settings = await prisma.systemSettings.findUnique({ where: { id: "settings" } });
    const total = deliveries.length;
    const completed = deliveries.filter((d) => d.status === DeliveryStatus.COMPLETED).length;
    const failed = deliveries.filter((d) => d.status === DeliveryStatus.FAILED).length;
    const routes = await prisma.route.findMany({
      where: { status: "COMPLETED" },
      select: { distanceKm: true, fuelCostBrl: true },
    });
    const totalKm = routes.reduce((a, r) => a + r.distanceKm, 0);
    const totalFuel = routes.reduce((a, r) => a + r.fuelCostBrl, 0);

    const doc = new PDFDocument({ margin: 50 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="relatorio-${Date.now()}.pdf"`);
    doc.pipe(res);

    doc.fontSize(20).text(settings?.companyName ?? "RotaCerta", { align: "center" });
    doc.moveDown(0.3);
    doc.fontSize(12).fillColor("#555").text("Relatório Operacional de Entregas", { align: "center" });
    doc.fontSize(9).text(`Gerado em ${new Date().toLocaleString("pt-BR")}`, { align: "center" });
    doc.moveDown(1.5);

    doc.fillColor("#000").fontSize(13).text("Resumo do período");
    doc.moveDown(0.5);
    doc.fontSize(10);
    doc.text(`Total de entregas: ${total}`);
    doc.text(`Concluídas: ${completed} (${total ? Math.round((completed / total) * 100) : 0}%)`);
    doc.text(`Falhas: ${failed}`);
    doc.text(`Distância total (rotas finalizadas): ${totalKm.toFixed(1)} km`);
    doc.text(`Custo estimado de combustível: R$ ${totalFuel.toFixed(2)}`);
    doc.moveDown(1.5);

    doc.fontSize(13).text("Detalhamento");
    doc.moveDown(0.5);
    doc.fontSize(8);
    deliveries.slice(0, 200).forEach((d, i) => {
      doc.fillColor(i % 2 ? "#333" : "#000").text(
        `${d.createdAt.toLocaleDateString("pt-BR")} | ${d.customer.name} | ${STATUS_PT[d.status] ?? d.status} | ${d.driver?.user.name ?? "—"}`,
        { width: 500 }
      );
    });
    doc.end();
  } catch (e) {
    next(e);
  }
});

export default router;
