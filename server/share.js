import sharp from 'sharp';

// Link previews for a contestant's voting link (WhatsApp, Facebook, X and others): her name, a
// line about voting, and her photo as a large image. Only for approved contestants with a photo.

const activeContestant = (db, code) => db.prepare("SELECT * FROM contestants WHERE code = ? AND status = 'approved'").get(code);

export async function sharePreview(ctx, code) {
  const c = code ? await activeContestant(ctx.db, code) : null;
  if (!c) return null;
  const { publicUrl } = ctx.config;
  return {
    title: `Vote for ${c.stage_name} 👑 | MBGN`,
    description: `${c.stage_name} from ${c.state} is in Most Beautiful Girl Online Nigeria. Tap to vote for her with code ${c.code}.`,
    image: c.photo_file ? `${publicUrl}/api/share/${c.code}.jpg` : `${publicUrl}/icons/icon-512.png`,
    url: `${publicUrl}/c/${c.code}`,
  };
}

// The wide shape previews show large. Her whole photo, never cropped (so her face always shows),
// in the middle of a blurred, darkened copy of itself that fills the frame. Small enough for
// WhatsApp to always load, and made once per photo, then kept next to it.
const WIDTH = 1200;
const HEIGHT = 630;

export async function shareImage(ctx, code) {
  const c = code ? await activeContestant(ctx.db, code) : null;
  if (!c?.photo_file) return null;
  const file = `share-v2-${c.photo_file.replace(/\.\w+$/, '')}.jpg`;
  const saved = await ctx.photos.get(file);
  if (saved) return saved;
  const original = await ctx.photos.get(c.photo_file);
  if (!original) return null;
  const photo = sharp(original).rotate();
  const backdrop = await photo.clone().resize(WIDTH, HEIGHT, { fit: 'cover' }).blur(28).modulate({ brightness: 0.5 }).toBuffer();
  const front = await photo.clone().resize(WIDTH, HEIGHT, { fit: 'inside' }).toBuffer();
  const { width, height } = await sharp(front).metadata();
  const image = await sharp(backdrop)
    .composite([{ input: front, left: Math.round((WIDTH - width) / 2), top: Math.round((HEIGHT - height) / 2) }])
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();
  await ctx.photos.put(file, image, 'image/jpeg');
  return image;
}
