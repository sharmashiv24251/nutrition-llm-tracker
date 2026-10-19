import { body, handle } from "@/lib/http";
import { CreateExercise } from "@/lib/schemas";
import { data } from "@/lib/server";

/** The exercise library: every exercise with notes and how much it's been trained. */
export async function GET() {
  return handle(async () => Response.json({ exercises: await data.exerciseLibrary() }));
}

/** Adds an exercise. A close existing match comes back as 409 with the candidates, unless distinct_from is set. */
export async function POST(req: Request) {
  return handle(async () => {
    const res = await data.createExercise(await body(req, CreateExercise));
    return Response.json(res, { status: res.created ? 201 : 409 });
  });
}
