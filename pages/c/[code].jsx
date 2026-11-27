import Head from 'next/head';
import Page from '../[[...slug]].jsx';
import { normalizeCode } from '../../server/routes/public.js';
import { getContext } from '../../server/runtime.js';
import { sharePreview } from '../../server/share.js';

// A contestant's voting link: the same page as everywhere else, plus what link previews read
// (WhatsApp, Facebook, X): her name, a line about voting, and her photo.
export default function ContestantLink({ preview, siteTitle = null, country = "ng" }) {
  return (
    <>
      <Page country={country} />
      {/* The country's own name, when there's no contestant to preview. */}
      {!preview && siteTitle ? <Head><title key="title">{siteTitle}</title><meta key="og:title" property="og:title" content={siteTitle} /></Head> : null}
      {preview ? (
        <Head>
          <title key="title">{preview.title}</title>
          <meta key="description" name="description" content={preview.description} />
          <meta key="og:type" property="og:type" content="website" />
          <meta key="og:site_name" property="og:site_name" content="MBGN" />
          <meta key="og:title" property="og:title" content={preview.title} />
          <meta key="og:description" property="og:description" content={preview.description} />
          <meta key="og:url" property="og:url" content={preview.url} />
          <meta key="og:image" property="og:image" content={preview.image} />
          <meta key="og:image:secure_url" property="og:image:secure_url" content={preview.image} />
          <meta key="og:image:type" property="og:image:type" content="image/jpeg" />
          <meta key="og:image:width" property="og:image:width" content="1200" />
          <meta key="og:image:height" property="og:image:height" content="630" />
          <meta key="og:image:alt" property="og:image:alt" content={preview.alt} />
          <meta key="twitter:card" name="twitter:card" content="summary_large_image" />
          <meta key="twitter:image" name="twitter:image" content={preview.image} />
        </Head>
      ) : null}
    </>
  );
}

export async function getServerSideProps({ params, req, res }) {
  // Previews are fetched often and rarely change, so the network keeps a copy for a few minutes.
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
  try {
    const ctx = await getContext(req);
    const { short, siteName } = ctx.config.country;
    return { props: { preview: await sharePreview(ctx, normalizeCode(params.code)), siteTitle: `${short} | ${siteName}`, country: ctx.config.countryId } };
  } catch (err) {
    console.error('Link preview failed:', err.message);
    return { props: { preview: null } };
  }
}
