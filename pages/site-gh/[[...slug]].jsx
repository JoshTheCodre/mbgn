import Head from 'next/head';
import Page from '../[[...slug]].jsx';

// Ghana's copy of the page shell, served on the Ghana domain (see middleware.js): the same site,
// with Ghana's name in what crawlers and link previews read.
export default function GhanaPage() {
  return (
    <>
      <Head>
        <title key="title">MBGG | Most Beautiful Girl Ghana</title>
        <meta key="description" name="description" content="Join or support a contestant in Most Beautiful Girl Ghana. Vote with Mobile Money." />
        <meta key="og:title" property="og:title" content="Most Beautiful Girl Ghana" />
        <meta key="og:description" property="og:description" content="Join or support a contestant in Most Beautiful Girl Ghana." />
      </Head>
      <Page country="gh" />
    </>
  );
}
