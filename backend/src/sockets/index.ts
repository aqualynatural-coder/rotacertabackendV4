import { Server as SocketIOServer, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { Role, DeliveryStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { haversineKm, detectGpsSpoof } from "../utils/logic";
import { doCheckIn, doCheckOut } from "../routes/shift.routes";
import { pushToAdmins, pushToUser } from "../services/push";

interface AuthPayload {
  id: string;
  email: string;
  role: Role;
}

// Raio (metros) para auto-chegada em uma entrega
const ARRIVAL_RADIUS_M = 60;

async function getHQ() {
  const s = await prisma.systemSettings.findUnique({ where: { id: "settings" } });
  if (s?.hqLatitude != null && s?.hqLongitude != null) {
    return { lat: s.hqLatitude, lng: s.hqLongitude, radiusM: s.hqRadiusM ?? 150 };
  }
  return null;
}

export function registerSockets(io: SocketIOServer) {
  // Auth middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error("Token ausente"));
    try {
      const payload = jwt.verify(String(token), process.env.JWT_SECRET!) as AuthPayload;
      (socket as any).user = payload;
      next();
    } catch {
      next(new Error("Token inválido"));
    }
  });

  io.on("connection", async (socket: Socket) => {
    const user = (socket as any).user as AuthPayload;
    console.log(`🔌 Socket conectado: ${user.email} (${user.role})`);

    let driverId: string | null = null;

    if (user.role === Role.ADMIN) {
      socket.join("admin");
    } else if (user.role === Role.DRIVER) {
      const driver = await prisma.driver.findFirst({ where: { userId: user.id } });
      if (driver) {
        driverId = driver.id;
        socket.join(`driver:${driver.id}`);
      }
    }

    // ============================
    // CHAT — escritório <-> motorista
    // ============================
    socket.on("chat:send", async (data: { driverId?: string; body: string }) => {
      const body = String(data.body ?? "").trim().slice(0, 1000);
      if (!body) return;

      let targetDriverId = driverId;
      if (user.role === Role.ADMIN) {
        targetDriverId = data.driverId ?? null;
      }
      if (!targetDriverId) return;

      const msg = await prisma.chatMessage.create({
        data: { driverId: targetDriverId, senderId: user.id, senderRole: user.role, body },
      });

      io.to("admin").emit("chat:message", msg);
      io.to(`driver:${targetDriverId}`).emit("chat:message", msg);

      // Push para o destinatário
      if (user.role === Role.ADMIN) {
        const drv = await prisma.driver.findUnique({ where: { id: targetDriverId } });
        if (drv) pushToUser(drv.userId, { title: "💬 Mensagem do escritório", body, url: "/motorista/chat", tag: `chat-${targetDriverId}` });
      } else {
        pushToAdmins({ title: "💬 Mensagem do motorista", body, url: "/admin/chat", tag: `chat-${targetDriverId}` });
      }
    });

    socket.on("chat:read", async (data: { driverId?: string }) => {
      const target = user.role === Role.ADMIN ? data.driverId : driverId;
      if (!target) return;
      const other = user.role === Role.ADMIN ? "DRIVER" : "ADMIN";
      await prisma.chatMessage.updateMany({
        where: { driverId: target, senderRole: other as Role, read: false },
        data: { read: true },
      });
    });

    // ============================
    // LOCALIZAÇÃO — ping do motorista
    // ============================
    socket.on("driver:location", async (data: { latitude: number; longitude: number; speed?: number; heading?: number; accuracy?: number; routeId?: string }) => {
      if (user.role !== Role.DRIVER || !driverId) return;
      const now = new Date();

      // --- Anti-spoof: compara com último ping ---
      const lastPing = await prisma.locationPing.findFirst({
        where: { driverId },
        orderBy: { recordedAt: "desc" },
      });
      const spoof = detectGpsSpoof(
        { latitude: data.latitude, longitude: data.longitude, speed: data.speed ?? null, accuracy: data.accuracy ?? null, recordedAt: now },
        lastPing
          ? { latitude: lastPing.latitude, longitude: lastPing.longitude, speed: lastPing.speed, accuracy: lastPing.accuracy, recordedAt: lastPing.recordedAt }
          : null
      );
      if (spoof.suspect) {
        io.to("admin").emit("alert:gps_suspect", { driverId, reason: spoof.reason, at: now });
        await prisma.notification.create({
          data: {
            userId: user.id, type: "GPS_SUSPECT",
            title: "Localização suspeita detectada",
            body: `Ping marcado como suspeito (${spoof.reason}). Verifique o dispositivo.`,
            data: { driverId, reason: spoof.reason },
          },
        }).catch(() => null);
      }

      // Persiste ping
      await prisma.locationPing.create({
        data: {
          driverId,
          routeId: data.routeId,
          latitude: data.latitude,
          longitude: data.longitude,
          speed: data.speed,
          heading: data.heading,
          accuracy: data.accuracy,
          suspect: spoof.suspect,
          suspectReason: spoof.reason ?? null,
          recordedAt: now,
        },
      }).catch(() => null);

      // Broadcast para o escritório
      io.to("admin").emit("driver:location", {
        driverId,
        latitude: data.latitude,
        longitude: data.longitude,
        speed: data.speed,
        heading: data.heading,
        suspect: spoof.suspect,
        recordedAt: now,
      });

      // --- GEOFENCE 1: sede da empresa → auto check-in / check-out ---
      const hq = await getHQ();
      if (hq) {
        const distToHQ = haversineKm(data.latitude, data.longitude, hq.lat, hq.lng) * 1000;
        if (distToHQ <= hq.radiusM) {
          const date = new Date(); date.setHours(0, 0, 0, 0);
          const shift = await prisma.shift.findUnique({
            where: { driverId_date: { driverId, date } },
          });
          const driver = await prisma.driver.findUnique({ where: { id: driverId }, include: { user: true } });
          const name = driver?.user.name ?? "Motorista";

          if (!shift) {
            // 🌅 Auto check-in: motorista entrou na área da empresa e ainda não tem expediente
            const { created } = await doCheckIn(driverId, data.latitude, data.longitude, true);
            if (created) {
              io.to("admin").emit("shift:started", { driverId, name, at: now, auto: true });
              io.to(`driver:${driverId}`).emit("shift:self", { type: "check-in", at: now, auto: true });
              await prisma.notification.create({
                data: { userId: user.id, type: "SHIFT_STARTED", title: "Expediente iniciado", body: `${name} chegou à empresa às ${now.toLocaleTimeString("pt-BR")} (automático)` },
              }).catch(() => null);
              pushToAdmins({ title: "🌅 Expediente iniciado", body: `${name} chegou à empresa`, tag: "shift" });
            }
          } else if (!shift.checkOutAt) {
            // 🏁 Auto check-out: voltou à empresa E não tem entregas pendentes
            const pendingCount = await prisma.delivery.count({
              where: {
                driverId,
                status: { in: [DeliveryStatus.ASSIGNED, DeliveryStatus.IN_TRANSIT, DeliveryStatus.ARRIVED] },
              },
            });
            // Só fecha sozinho se não houver entregas abertas (fim real do dia)
            if (pendingCount === 0) {
              const { created } = await doCheckOut(driverId, data.latitude, data.longitude, true);
              if (created) {
                io.to("admin").emit("shift:ended", { driverId, name, at: now, auto: true });
                io.to(`driver:${driverId}`).emit("shift:self", { type: "check-out", at: now, auto: true });
                await prisma.notification.create({
                  data: { userId: user.id, type: "SHIFT_ENDED", title: "Expediente encerrado", body: `${name} retornou à empresa às ${now.toLocaleTimeString("pt-BR")} (automático)` },
                }).catch(() => null);
                pushToAdmins({ title: "🏁 Expediente encerrado", body: `${name} voltou para a empresa`, tag: "shift" });
              }
            }
          }
        }
      }

      // --- GEOFENCE 2: chegada automática em entrega (raio 60m) ---
      const inTransit = await prisma.delivery.findMany({
        where: { driverId, status: { in: [DeliveryStatus.ASSIGNED, DeliveryStatus.IN_TRANSIT] } },
        include: { customer: true },
      });
      for (const d of inTransit) {
        const distM = haversineKm(data.latitude, data.longitude, d.customer.latitude, d.customer.longitude) * 1000;
        if (distM <= ARRIVAL_RADIUS_M) {
          await prisma.delivery.update({
            where: { id: d.id },
            data: { status: DeliveryStatus.ARRIVED, arrivedAt: now, arrivedLat: data.latitude, arrivedLng: data.longitude },
          });
          io.to("admin").emit("delivery:arrived", { deliveryId: d.id, driverId, customer: d.customer.name, at: now, auto: true });
          io.to(`driver:${driverId}`).emit("delivery:arrived", { deliveryId: d.id, customer: d.customer.name, auto: true });
        }
      }
    });

    socket.on("disconnect", () => {
      console.log(`❌ Socket desconectado: ${user.email}`);
    });
  });
}
