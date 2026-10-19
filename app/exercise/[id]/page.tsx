import { Suspense } from "react";
import { ExerciseDetail } from "@/components/ExerciseDetail";

export default function ExercisePage() {
  // The exercise id comes from useParams() at request time.
  return (
    <Suspense>
      <ExerciseDetail />
    </Suspense>
  );
}
