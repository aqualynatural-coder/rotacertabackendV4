// ============================================================
// Lógica pura de negócio — sem IA, só matemática
// ============================================================

// Distância Haversine entre dois pontos (km)
export function haversineKm(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg: number) {
  return (deg * Math.PI) / 180;
}

// Calcula distância total de um trajeto (array de pings ordenados)
export function totalDistanceKm(
  points: { latitude: number; longitude: number }[]
): number {
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const d = haversineKm(a.latitude, a.longitude, b.latitude, b.longitude);
    // Ignora saltos absurdos (> 5km entre pings) — provavelmente GPS ruim
    if (d < 5) total += d;
  }
  return total;
}

// Combustível: distância / km por litro
export function fuelUsedLiters(distanceKm: number, kmPerLiter: number): number {
  if (kmPerLiter <= 0) return 0;
  return distanceKm / kmPerLiter;
}

// Custo: litros * preço por litro
export function fuelCostBrl(liters: number, pricePerLiter: number): number {
  return liters * pricePerLiter;
}

// Classifica atraso de uma entrega (em minutos)
export type DelayLevel = "on_time" | "attention" | "critical";

export function classifyDelay(scheduledAt: Date | null, now: Date = new Date()): DelayLevel {
  if (!scheduledAt) return "on_time";
  const diffMin = (now.getTime() - scheduledAt.getTime()) / 60_000;
  if (diffMin > 30) return "critical"; // > 30 min atrasado
  if (diffMin > 10) return "attention"; // 10-30 min atrasado
  return "on_time";
}

// Verifica manutenção pendente
export function needsMaintenance(kmSinceMaintenance: number, limitKm: number): boolean {
  return kmSinceMaintenance >= limitKm;
}

// ============================================================
// Otimizador de rota — TSP aproximado (nearest neighbor)
// Ordena paradas minimizando km totais. Sem API paga.
// ============================================================
export interface Stop {
  id: string;
  latitude: number;
  longitude: number;
}

export function optimizeRouteOrder(
  stops: Stop[],
  start?: { latitude: number; longitude: number } | null
): Stop[] {
  if (stops.length <= 2) return [...stops];
  const remaining = [...stops];
  const ordered: Stop[] = [];
  // Começa da sede (se informada) ou da primeira parada
  let current = start
    ? { ...start, id: "__hq__" }
    : remaining.shift()!;
  if (!start) ordered.push(current as Stop);

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(
        current.latitude, current.longitude,
        remaining[i].latitude, remaining[i].longitude
      );
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    current = remaining.splice(bestIdx, 1)[0];
    ordered.push(current as Stop);
  }
  return ordered;
}

// Estima km totais de uma ordem de paradas (para comparar antes/depois)
export function estimateRouteKm(
  stops: { latitude: number; longitude: number }[],
  start?: { latitude: number; longitude: number } | null
): number {
  const pts = start ? [start, ...stops] : stops;
  return totalDistanceKm(pts);
}

// ============================================================
// Anti-spoof GPS — detecta pontos suspeitos (lógica pura)
// ============================================================
export interface PingInput {
  latitude: number;
  longitude: number;
  speed?: number | null;      // m/s
  accuracy?: number | null;   // m
  recordedAt: Date;
}

export function detectGpsSpoof(
  ping: PingInput,
  lastPing?: PingInput | null
): { suspect: boolean; reason?: string } {
  // 1. Precisão péssima (mock locations costumam vir sem accuracy real)
  if (ping.accuracy != null && ping.accuracy > 500) {
    return { suspect: true, reason: "accuracy_baixa" };
  }
  // 2. Velocidade fisicamente impossível (> 240 km/h = 66.7 m/s)
  if (ping.speed != null && ping.speed > 66.7) {
    return { suspect: true, reason: "velocidade_impossivel" };
  }
  // 3. Teleporte: distância vs tempo desde o último ping
  if (lastPing) {
    const dtSec = (ping.recordedAt.getTime() - lastPing.recordedAt.getTime()) / 1000;
    if (dtSec > 0 && dtSec < 300) {
      const distKm = haversineKm(
        lastPing.latitude, lastPing.longitude,
        ping.latitude, ping.longitude
      );
      const maxKm = (66.7 * dtSec) / 1000; // máximo percorrível a 240 km/h
      if (distKm > maxKm * 1.5 && distKm > 2) {
        return { suspect: true, reason: "teleporte" };
      }
    }
  }
  return { suspect: false };
}

// Formata comparação de tempo (gamificação)
export function compareTimeMessage(
  todayMinutes: number,
  referenceMinutes: number
): string | null {
  const diff = referenceMinutes - todayMinutes;
  if (diff > 5) {
    return `🎉 Você está ${Math.round(diff)} minutos mais rápido hoje do que na média! Continue assim!`;
  }
  if (diff < -5) {
    return `💪 Hoje está um pouco mais corrido (${Math.round(-diff)} min a mais que a média). Foco que amanhã melhora!`;
  }
  return "👍 Ritmo consistente com sua média. Bom trabalho!";
}
