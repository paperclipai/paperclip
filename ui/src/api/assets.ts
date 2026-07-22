import type { AssetImage } from "@paperclipai/shared";
import { api } from "./client";

export const assetsApi = {
  uploadImage: async (companyId: string, file: File, namespace?: string) => {
    // Read file data into memory eagerly so the fetch body is self-contained.
    // Clipboard-paste File objects reference transient data that the browser may
    // discard after the paste-event handler returns, causing ERR_ACCESS_DENIED
    // when fetch() later tries to stream the FormData body.
    const buffer = await file.arrayBuffer();
    const safeFile = new File([buffer], file.name, { type: file.type });

    const form = new FormData();
    if (namespace && namespace.trim().length > 0) {
      form.append("namespace", namespace.trim());
    }
    form.append("file", safeFile);
    return api.postForm<AssetImage>(`/companies/${companyId}/assets/images`, form);
  },

  uploadCompanyLogo: async (companyId: string, file: File) => {
    const buffer = await file.arrayBuffer();
    const safeFile = new File([buffer], file.name, { type: file.type });

    const form = new FormData();
    form.append("file", safeFile);
    return api.postForm<AssetImage>(`/companies/${companyId}/logo`, form);
  },
};
