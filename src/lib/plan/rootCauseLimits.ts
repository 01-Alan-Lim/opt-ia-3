// src/lib/plan/rootCauseLimits.ts

// Límite de causas raíz compartido entre Etapa 4 (Ishikawa) y Etapa 5 (Pareto).
// Decisión metodológica (CLAUDE.md): Ishikawa exige al menos MIN_ROOT_CAUSES para
// cerrar; Pareto no tiene mínimo ni tope propio y recibe todas las raíces de Ishikawa.

export const MIN_ROOT_CAUSES = 10;
