"use client";

// Pestaña Dashboard de /docente: panel nativo de seguimiento por cohorte
// (dashboard/CohortProgressDashboard.tsx, con datos de GET /api/teacher/dashboard).

import { CohortProgressDashboard } from "./dashboard/CohortProgressDashboard";

export function TeacherDashboard() {
  return <CohortProgressDashboard />;
}
