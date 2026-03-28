export function shouldRegisterServiceWorker(opts: {
  isProduction: boolean;
  hasServiceWorkerApi: boolean;
}) {
  return opts.isProduction && opts.hasServiceWorkerApi;
}
