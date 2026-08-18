import type { ImageAttachment } from "../../shared/src/protocol";

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const MESSAGE_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGES = 4;
const MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
] as const;

export function validateImages(images: unknown): ImageAttachment[] {
	if (images === undefined) return [];
	if (!Array.isArray(images)) throw new Error("images must be an array");
	if (images.length > MAX_IMAGES)
		throw new Error(`at most ${MAX_IMAGES} images are allowed`);
	let total = 0;
	return images.map((candidate, index) => {
		if (!candidate || typeof candidate !== "object")
			throw new Error(`image ${index + 1} is invalid`);
		const image = candidate as Partial<ImageAttachment>;
		if (typeof image.id !== "string" || !image.id)
			throw new Error(`image ${index + 1} id is required`);
		if (!UUID.test(image.id))
			throw new Error(`image ${index + 1} id must be a UUID`);
		if (!MIME_TYPES.includes(image.mimeType as (typeof MIME_TYPES)[number]))
			throw new Error(`image ${index + 1} MIME type is unsupported`);
		if (typeof image.data !== "string" || !isCanonicalBase64(image.data))
			throw new Error(`image ${index + 1} data is invalid base64`);
		const bytes = Buffer.from(image.data, "base64");
		if (!bytes.length) throw new Error(`image ${index + 1} is empty`);
		if (bytes.length > IMAGE_MAX_BYTES)
			throw new Error(`image ${index + 1} exceeds the 8 MiB limit`);
		if (!matchesMime(bytes, image.mimeType as ImageAttachment["mimeType"]))
			throw new Error(`image ${index + 1} MIME does not match its data`);
		total += bytes.length;
		if (total > MESSAGE_MAX_IMAGE_BYTES)
			throw new Error("images exceed the 20 MiB message limit");
		return {
			id: image.id,
			mimeType: image.mimeType,
			data: image.data,
		} as ImageAttachment;
	});
}

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isCanonicalBase64(value: string): boolean {
	return (
		value.length % 4 === 0 &&
		/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			value,
		) &&
		Buffer.from(value, "base64").toString("base64") === value
	);
}

function matchesMime(
	bytes: Uint8Array,
	mime: ImageAttachment["mimeType"],
): boolean {
	if (mime === "image/png")
		return (
			bytes.length >= 8 &&
			bytes
				.slice(0, 8)
				.every(
					(byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index],
				)
		);
	if (mime === "image/jpeg")
		return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	if (mime === "image/gif")
		return (
			new TextDecoder().decode(bytes.slice(0, 6)) === "GIF87a" ||
			new TextDecoder().decode(bytes.slice(0, 6)) === "GIF89a"
		);
	return (
		bytes.length >= 12 &&
		new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
		new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
	);
}
