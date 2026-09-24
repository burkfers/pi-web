import type { FastifyInstance } from "fastify";
import type { ProjectActivityService } from "./projectActivityService.js";

export function registerProjectActivityRoutes(app: FastifyInstance, activity: Pick<ProjectActivityService, "snapshot">): void {
  app.get("/projects/activity", async () => activity.snapshot());
}
