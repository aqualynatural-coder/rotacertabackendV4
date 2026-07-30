import { prisma } from "../lib/prisma";

export async function audit(params: {
  userId?: string;
  action: string;
  entity: string;
  entityId?: string;
  metadata?: any;
  ip?: string;
}) {
  try {
    await prisma.auditLog.create({ data: params });
  } catch (e) {
    console.error("[audit] falha ao registrar:", e);
  }
}
