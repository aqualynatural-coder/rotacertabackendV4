import { PrismaClient, Role, DeliveryStatus, RouteStatus } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seed v2 iniciando...");

  await prisma.deliveryFailure.deleteMany();
  await prisma.proofOfDelivery.deleteMany();
  await prisma.locationPing.deleteMany();
  await prisma.chatMessage.deleteMany();
  await prisma.trackingLink.deleteMany();
  await prisma.pushSubscription.deleteMany();
  await prisma.shift.deleteMany();
  await prisma.delivery.deleteMany();
  await prisma.route.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.vehicle.deleteMany();
  await prisma.driver.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.user.deleteMany();
  await prisma.systemSettings.deleteMany();

  // Configurações padrão (com sede demo — Paulista, São Paulo)
  await prisma.systemSettings.create({
    data: {
      id: "settings",
      companyName: "RotaCerta",
      accentColor: "#0EA5E9",
      hqAddress: "Av. Paulista, 1000 - Bela Vista, São Paulo - SP",
      hqLatitude: -23.5614,
      hqLongitude: -46.6559,
      hqRadiusM: 150,
    },
  });

  const adminHash = await bcrypt.hash("admin123", 12);
  const driverHash = await bcrypt.hash("motorista123", 12);

  // ⚠️ Contas marcadas como isDemo: true — podem ser excluídas com 1 clique
  const admin = await prisma.user.create({
    data: {
      name: "Administrador Demo",
      email: "admin@rotacerta.app",
      passwordHash: adminHash,
      role: Role.ADMIN,
      isDemo: true,
    },
  });

  const driverUser = await prisma.user.create({
    data: {
      name: "Carlos Motorista (Demo)",
      email: "motorista@rotacerta.app",
      passwordHash: driverHash,
      role: Role.DRIVER,
      isDemo: true,
      driver: {
        create: {
          phone: "+5511999998888",
          licenseNumber: "SP-12345678",
          vehiclePlate: "RCT-2A26",
          vehicleModel: "Fiat Fiorino 2024",
          vehicle: {
            create: {
              plate: "RCT-2A26",
              model: "Fiat Fiorino 2024",
              fuelConsumptionKmL: 12.5,
              fuelPricePerLiter: 5.89,
              maintenanceKmLimit: 10000,
              kmSinceMaintenance: 3200,
            },
          },
        },
      },
    },
    include: { driver: true },
  });

  const driver2 = await prisma.user.create({
    data: {
      name: "Ana Souza (Demo)",
      email: "ana@rotacerta.app",
      passwordHash: driverHash,
      role: Role.DRIVER,
      isDemo: true,
      driver: {
        create: {
          phone: "+5511988887777",
          licenseNumber: "SP-87654321",
          vehiclePlate: "RCT-9B99",
          vehicleModel: "VW Saveiro 2023",
          vehicle: {
            create: {
              plate: "RCT-9B99",
              model: "VW Saveiro 2023",
              fuelConsumptionKmL: 10.0,
              fuelPricePerLiter: 5.89,
              maintenanceKmLimit: 8000,
              kmSinceMaintenance: 7900,
            },
          },
        },
      },
    },
    include: { driver: true },
  });

  // Clientes de teste (marcados)
  const customers = await Promise.all([
    prisma.customer.create({ data: { name: "Padaria Pão Quente", phone: "+551133334444", address: "Av. Paulista, 1500", city: "São Paulo", state: "SP", zipCode: "01310-100", latitude: -23.561414, longitude: -46.655881, isTest: true } }),
    prisma.customer.create({ data: { name: "Mercado Bom Preço", phone: "+551133335555", address: "R. Augusta, 2000", city: "São Paulo", state: "SP", zipCode: "01412-100", latitude: -23.556263, longitude: -46.662193, isTest: true } }),
    prisma.customer.create({ data: { name: "Farmácia Vida", phone: "+551133336666", address: "R. Oscar Freire, 800", city: "São Paulo", state: "SP", zipCode: "01426-000", latitude: -23.562634, longitude: -46.671283, isTest: true } }),
    prisma.customer.create({ data: { name: "Restaurante Sabor Caseiro", phone: "+551133337777", address: "R. Haddock Lobo, 500", city: "São Paulo", state: "SP", zipCode: "01414-001", latitude: -23.55912, longitude: -46.66405, isTest: true } }),
    prisma.customer.create({ data: { name: "Loja Elétrica Central", phone: "+551133338888", address: "Av. Rebouças, 1200", city: "São Paulo", state: "SP", zipCode: "05402-100", latitude: -23.56542, longitude: -46.6781, isTest: true } }),
  ]);

  const today = new Date();
  today.setHours(8, 0, 0, 0);

  const route1 = await prisma.route.create({
    data: {
      name: "Rota Centro-SP - Manhã (Demo)",
      status: RouteStatus.PLANNED,
      driverId: driverUser.driver!.id,
      scheduledFor: today,
    },
  });

  for (let i = 0; i < customers.length; i++) {
    const scheduled = new Date(today.getTime() + (i + 1) * 45 * 60 * 1000);
    await prisma.delivery.create({
      data: {
        routeId: route1.id,
        customerId: customers[i].id,
        driverId: driverUser.driver!.id,
        sequence: i + 1,
        status: DeliveryStatus.ASSIGNED,
        scheduledAt: scheduled,
        notes: `Entrega #${i + 1} da rota da manhã`,
      },
    });
  }

  const route2 = await prisma.route.create({
    data: {
      name: "Rota Zona Sul - Tarde (Demo)",
      status: RouteStatus.PLANNED,
      driverId: driver2.driver!.id,
      scheduledFor: new Date(today.getTime() + 6 * 60 * 60 * 1000),
    },
  });

  await prisma.delivery.create({
    data: {
      routeId: route2.id,
      customerId: customers[0].id,
      driverId: driver2.driver!.id,
      sequence: 1,
      status: DeliveryStatus.ASSIGNED,
      scheduledAt: new Date(today.getTime() + 7 * 60 * 60 * 1000),
    },
  });

  console.log("✅ Seed v2 concluído!");
  console.log("👔 Admin (demo): admin@rotacerta.app / admin123");
  console.log("🚚 Motorista (demo): motorista@rotacerta.app / motorista123");
  console.log("🚚 Motorista 2 (demo): ana@rotacerta.app / motorista123");
  console.log("ℹ️  Contas e clientes marcados como DEMO/TESTE — podem ser excluídos em Configurações");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
