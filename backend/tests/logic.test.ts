// ============================================================
// Testes unitários da lógica pura de negócio (Vitest)
// Rodar: npm run test
// ============================================================
import { describe, it, expect } from "vitest";
import {
  haversineKm,
  totalDistanceKm,
  fuelUsedLiters,
  fuelCostBrl,
  classifyDelay,
  needsMaintenance,
  optimizeRouteOrder,
  detectGpsSpoof,
} from "../src/utils/logic";

describe("haversineKm", () => {
  it("calcula distância real entre dois pontos de SP", () => {
    // Paulista x Ibirapuera ≈ 2.5-3 km
    const d = haversineKm(-23.5614, -46.6559, -23.5874, -46.6576);
    expect(d).toBeGreaterThan(2);
    expect(d).toBeLessThan(4);
  });
  it("distância zero para o mesmo ponto", () => {
    expect(haversineKm(-23.5, -46.6, -23.5, -46.6)).toBe(0);
  });
});

describe("totalDistanceKm", () => {
  it("soma trajeto ignorando saltos GPS absurdos", () => {
    const pts = [
      { latitude: -23.5614, longitude: -46.6559 },
      { latitude: -23.5620, longitude: -46.6560 },
      { latitude: -23.5630, longitude: -46.6561 },
      { latitude: -22.0, longitude: -43.0 }, // teleporte > 5km — deve ser ignorado
      { latitude: -23.5640, longitude: -46.6562 },
    ];
    const d = totalDistanceKm(pts);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(1); // sem o salto, trajeto é curto
  });
});

describe("combustível", () => {
  it("fuelUsedLiters divide km pelo consumo", () => {
    expect(fuelUsedLiters(100, 10)).toBe(10);
    expect(fuelUsedLiters(0, 10)).toBe(0);
    expect(fuelUsedLiters(100, 0)).toBe(0);
  });
  it("fuelCostBrl multiplica litros pelo preço", () => {
    expect(fuelCostBrl(10, 5.8)).toBeCloseTo(58);
  });
});

describe("classifyDelay", () => {
  it("sem agendamento = on_time", () => {
    expect(classifyDelay(null)).toBe("on_time");
  });
  it("atrasos progressivos", () => {
    const now = new Date("2026-07-29T12:00:00Z");
    expect(classifyDelay(new Date("2026-07-29T11:55:00Z"), now)).toBe("on_time");
    expect(classifyDelay(new Date("2026-07-29T11:40:00Z"), now)).toBe("attention");
    expect(classifyDelay(new Date("2026-07-29T11:20:00Z"), now)).toBe("critical");
  });
});

describe("needsMaintenance", () => {
  it("dispara no limite", () => {
    expect(needsMaintenance(9999, 10000)).toBe(false);
    expect(needsMaintenance(10000, 10000)).toBe(true);
  });
});

describe("optimizeRouteOrder (TSP nearest neighbor)", () => {
  it("reduz ou mantém a distância total", () => {
    const stops = [
      { id: "a", latitude: -23.5614, longitude: -46.6559 },
      { id: "b", latitude: -23.7000, longitude: -46.7000 }, // longe
      { id: "c", latitude: -23.5630, longitude: -46.6565 }, // perto de a
      { id: "d", latitude: -23.6900, longitude: -46.6900 }, // perto de b
    ];
    const start = { latitude: -23.5614, longitude: -46.6559 };
    const ordered = optimizeRouteOrder(stops, start);
    expect(ordered).toHaveLength(4);
    expect(ordered[0].id).toBe("a"); // mais perto da sede
    expect(ordered[1].id).toBe("c"); // depois o vizinho mais próximo
  });
});

describe("detectGpsSpoof", () => {
  const base = { latitude: -23.5614, longitude: -46.6559, recordedAt: new Date("2026-07-29T12:00:00Z") };

  it("ping normal não é suspeito", () => {
    expect(detectGpsSpoof({ ...base, speed: 10, accuracy: 20 }).suspect).toBe(false);
  });
  it("precisão péssima é suspeita", () => {
    expect(detectGpsSpoof({ ...base, accuracy: 900 }).reason).toBe("accuracy_baixa");
  });
  it("velocidade impossível é suspeita", () => {
    expect(detectGpsSpoof({ ...base, speed: 120 }).reason).toBe("velocidade_impossivel");
  });
  it("teleporte entre pings é suspeito", () => {
    const last = { ...base, recordedAt: new Date("2026-07-29T11:59:30Z") }; // 30s atrás
    const jump = { latitude: -23.7, longitude: -46.8, recordedAt: new Date("2026-07-29T12:00:00Z") };
    expect(detectGpsSpoof(jump, last).reason).toBe("teleporte");
  });
});
