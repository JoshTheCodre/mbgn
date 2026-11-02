import Head from 'next/head';
import '../client/styles.css';

export default function App({ Component, pageProps }) {
  return (
    <>
      <Head>
        <title>MBGN | Most Beautiful Girl Online Nigeria</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="description" content="Over ₦10 million in cash prizes to be won. Join or support a contestant in Most Beautiful Girl Online Nigeria." />
        <meta property="og:title" content="Most Beautiful Girl Online Nigeria" />
        <meta property="og:description" content="Over ₦10 million in cash prizes to be won." />
        <meta name="theme-color" content="#24222e" />
      </Head>
      <Component {...pageProps} />
    </>
  );
}
