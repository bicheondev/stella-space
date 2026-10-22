export const measurementId='G-QQYQ0W3JDC';
// History-based page views are handled by GA4 enhanced measurement, not sent twice here.
export const googleAnalyticsTag=`<script async src="https://www.googletagmanager.com/gtag/js?id=${measurementId}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${measurementId}',{page_referrer:document.referrer.includes('/ops-')?'':document.referrer});</script>`;
