// The 3D view writes these from inside useFrame so tests can measure what the
// renderer actually drew, instead of inferring geometry from a screenshot.
interface Window {
  __aqarPlates?: number[];
  __aqarUnits?: Record<string, { y: number; floor: number | null; status: string }>;
  __aqarMap?: {
    getSource: (id: string) => unknown;
    querySourceFeatures: (id: string) => unknown[];
  };
}
