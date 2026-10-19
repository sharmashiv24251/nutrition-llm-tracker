import { Suspense } from "react";
import { DayView } from "@/components/DayView";

export default function DayPage() {
  // The day comes from useParams() at request time.
  return (
    <Suspense>
      <DayView />
    </Suspense>
  );
}
