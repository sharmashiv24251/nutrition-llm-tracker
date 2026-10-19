import { Suspense } from "react";
import { PlanScreen } from "@/components/PlanScreen";

export default function PlanPage() {
  // PlanScreen reads ?day= at request time.
  return (
    <Suspense>
      <PlanScreen />
    </Suspense>
  );
}
