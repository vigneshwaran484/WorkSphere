import { ensureUserExists } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { generateICSContent } from "@/lib/calendar";

export const dynamic = "force-dynamic";

/** GET /api/bookings/:bookingId/download — ICS calendar file for one of the caller's bookings. */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ bookingId: string }> },
) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    await ensureUserExists(userId);

    const { bookingId } = await context.params;
    const booking = await prisma.booking.findFirst({
      where: {
        OR: [{ id: bookingId }, { confirmationId: bookingId }],
        userId,
      },
      include: { venue: true, user: true },
    });

    if (!booking) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    const icsContent = generateICSContent(
      booking.venue.name,
      booking.venue.address,
      booking.date,
      booking.time,
      booking.duration ?? 60,
      booking.confirmationId ?? booking.id,
      booking.venue.latitude ?? undefined,
      booking.venue.longitude ?? undefined,
    );

    return new Response(icsContent, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `attachment; filename="worksphere-booking.ics"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("[Booking Download Error]:", error);
    return NextResponse.json(
      { error: "Failed to generate calendar file" },
      { status: 500 },
    );
  }
}
