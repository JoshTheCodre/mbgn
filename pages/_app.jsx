import Head from 'next/head';
import '../client/styles.css';

export default function App({ Component, pageProps }) {
  return (
    <>
      <Head>
        <title>MBGN | Most Beautiful Girl Online Nigeria</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="description" content="Vote for your favourite contestant in Most Beautiful Girl Online Nigeria. Live leaderboard, verified votes." />
        <meta name="theme-color" content="#24222e" />
      </Head>
      <Component {...pageProps} />
    </>
  );
}
