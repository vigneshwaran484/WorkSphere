import { GET } from "../../app/api/bookings/[bookingId]/download/route";
import { prisma } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import fs from "fs";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/auth", () => ({
  ensureUserExists: jest.fn(),
}));

jest.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findFirst: jest.fn(),
    },
  },
}));

describe("GET /api/bookings/[bookingId]/download", () => {
  const mockAuth = auth as unknown as jest.Mock;
  const mockFindFirst = (prisma as any).booking.findFirst as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 if unauthorized", async () => {
    mockAuth.mockResolvedValue({ userId: null });

    const req = {
      nextUrl: new URL("http://localhost/api/bookings/123/download"),
    };
    const context = { params: Promise.resolve({ bookingId: "123" }) };

    const res = await GET(req as any, context);
    expect(res.status).toBe(401);
  });

  it("returns 404 if booking not found", async () => {
    mockAuth.mockResolvedValue({ userId: "user_123" });
    mockFindFirst.mockResolvedValue(null);

    const req = {
      nextUrl: new URL("http://localhost/api/bookings/123/download"),
    };
    const context = { params: Promise.resolve({ bookingId: "123" }) };

    const res = await GET(req as any, context);
    expect(res.status).toBe(404);
  });

  it("returns 200 with ICS content type and valid payload", async () => {
    mockAuth.mockResolvedValue({ userId: "user_123" });
    mockFindFirst.mockResolvedValue({
      id: "booking_123",
      confirmationId: "WS-CONF-123",
      date: "2026-07-19",
      time: "12:00",
      duration: 60,
      venue: {
        name: "Test Venue",
        category: "cafe",
        address: "123 Test St",
        latitude: 12.34,
        longitude: 56.78,
      },
      user: {
        firstName: "John",
        lastName: "Doe",
      },
    });

    const req = {
      nextUrl: new URL("http://localhost/api/bookings/booking_123/download"),
    };
    const context = { params: Promise.resolve({ bookingId: "booking_123" }) };

    const res = await GET(req as any, context);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "text/calendar; charset=utf-8",
    );
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="worksphere-booking.ics"',
    );

    const text = await res.text();
    expect(text).toContain("BEGIN:VCALENDAR");
    expect(text).toContain("BEGIN:VEVENT");
    expect(text).toContain(
      "SUMMARY:Booking at Test Venue (60 min) [WS-CONF-123] - 123 Test St",
    );
    expect(text).toContain("GEO:12.34;56.78");
    expect(text).toContain("BEGIN:VALARM");
    expect(text).toContain("TRIGGER:-PT30M");
  });
});
