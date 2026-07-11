import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// The Loopa home is public (its header renders sign-in/sign-up when signed
// out, and the chat API enforces auth server-side). Watch pages (and their
// metadata API) are public so videos are shareable; the /videos library
// itself stays signed-in only.
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/videos/(.*)",
  "/api/videos/(.*)",
  // Session routes enforce auth themselves and return JSON/SSE — blocking
  // here made Clerk rewrite API POSTs to an HTML 404 while the UI hung on
  // "rolling…".
  "/api/session/(.*)",
]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
