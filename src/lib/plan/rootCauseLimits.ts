// src/lib/plan/rootCauseLimits.ts

// Límite de causas raíz compartido entre Etapa 4 (Ishikawa) y Etapa 5 (Pareto).
// Decisión metodológica (CLAUDE.md): Ishikawa exige al menos MIN_ROOT_CAUSES para
// cerrar; Pareto no tiene mínimo ni tope propio y recibe todas las raíces de Ishikawa.

export const MIN_ROOT_CAUSES = 10;

// Profundidad de porqués por rama (CLAUDE.md, Ishikawa E4): variable entre 3 y 5.
// El cierre es por CALIDAD (la causa es accionable), no por contador.

// Antes de MIN_WHY_DEPTH porqués nunca se cierra una rama.
export const MIN_WHY_DEPTH = 3;

// Tope duro: al llegar aquí sin causa accionable, se ayuda a reformular.
export const MAX_WHY_DEPTH = 5;
