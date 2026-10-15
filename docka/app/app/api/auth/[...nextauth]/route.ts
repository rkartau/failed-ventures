// Standard Auth.js v5 route handler. Exposes:
//   /api/auth/signin, /api/auth/callback/google, /api/auth/signout, /api/auth/session, …
import { handlers } from "@/auth";

export const { GET, POST } = handlers;
