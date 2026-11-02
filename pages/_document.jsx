import { Head, Html, Main, NextScript } from 'next/document';

const FONTS = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Fraunces:opsz,wght@9..144,500..800&family=Outfit:wght@400..800&family=Playfair+Display:wght@500..800&family=Syne:wght@500..800&display=swap';
const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%237b4be8' rx='8'/%3E%3Crect x='7' y='9' width='18' height='4' rx='2' fill='%23fff'/%3E%3Crect x='7' y='15' width='12' height='4' rx='2' fill='%23fff'/%3E%3Crect x='7' y='21' width='7' height='4' rx='2' fill='%23fff'/%3E%3C/svg%3E";

// Runs before anything is drawn:
// - the visitor's theme, so the page never flashes the wrong colours
// - the fonts, added this way so a slow connection never holds the page back waiting for them
// - the data the page will ask for, so it arrives alongside the scripts rather than after them
const EARLY = `(function(){
  var d=document,h=d.head;
  try{var t=localStorage.getItem('mbgn-theme');if(t)d.documentElement.dataset.theme=t}catch(e){}
  var f=d.createElement('link');f.rel='stylesheet';f.href=${JSON.stringify(FONTS)};h.appendChild(f);
  var want=['/api/competition'],voting=false;
  try{voting=JSON.parse(localStorage.getItem('mbgn-cache:/competition')).data.phase==='voting'}catch(e){}
  if(voting&&location.pathname==='/')want.push('/api/leaderboard?limit=5','/api/activity?limit=5');
  want.forEach(function(u){var l=d.createElement('link');l.rel='preload';l.as='fetch';l.crossOrigin='anonymous';l.href=u;h.appendChild(l)});
})()`;

export default function Document() {
  return (
    <Html lang="en" data-theme="owambe">
      <Head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="icon" href={ICON} />
        {/* eslint-disable-next-line react/no-danger */}
        <script dangerouslySetInnerHTML={{ __html: EARLY }} />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
