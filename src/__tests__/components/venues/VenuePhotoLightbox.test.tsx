import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import VenuePhotoLightbox from "../../../components/venues/VenuePhotoLightbox";
import "@testing-library/jest-dom";

const mockPhotos = [
  { id: "1", url: "photo1.jpg", alt: "Desk 1" },
  { id: "2", url: "photo2.jpg", alt: "Desk 2" },
  { id: "3", url: "photo3.jpg", alt: "Amenity 1" },
];

describe("VenuePhotoLightbox", () => {
  const onCloseMock = jest.fn();

  beforeEach(() => {
    onCloseMock.mockClear();
  });

  it("renders correctly when isOpen is true", () => {
    render(
      <VenuePhotoLightbox
        photos={mockPhotos}
        isOpen={true}
        onClose={onCloseMock}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByAltText("Desk 1")).toBeInTheDocument();
  });

  it("does not render when isOpen is false", () => {
    render(
      <VenuePhotoLightbox
        photos={mockPhotos}
        isOpen={false}
        onClose={onCloseMock}
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("navigates next and previous using keyboard arrows", () => {
    render(
      <VenuePhotoLightbox
        photos={mockPhotos}
        isOpen={true}
        onClose={onCloseMock}
      />,
    );

    // Initial image
    expect(screen.getByAltText("Desk 1")).toBeInTheDocument();

    // Arrow Right to go next
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByAltText("Desk 2")).toBeInTheDocument();

    // Arrow Right again
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByAltText("Amenity 1")).toBeInTheDocument();

    // Arrow Right to wrap around to start
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByAltText("Desk 1")).toBeInTheDocument();

    // Arrow Left to wrap around to end
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByAltText("Amenity 1")).toBeInTheDocument();

    // Arrow Left to go prev
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByAltText("Desk 2")).toBeInTheDocument();
  });

  it("calls onClose when Escape is pressed", () => {
    render(
      <VenuePhotoLightbox
        photos={mockPhotos}
        isOpen={true}
        onClose={onCloseMock}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCloseMock).toHaveBeenCalledTimes(1);
  });

  it("has proper accessibility attributes", () => {
    render(
      <VenuePhotoLightbox
        photos={mockPhotos}
        isOpen={true}
        onClose={onCloseMock}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-label", "Photo Gallery Lightbox");
  });
});
