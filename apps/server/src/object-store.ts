/// <reference types="@cloudflare/workers-types" />

import { AwsClient } from "aws4fetch";

export type MediaEnvironment = {
  MEDIA?: R2Bucket;
  MEDIA_S3_ENDPOINT?: string;
  MEDIA_S3_BUCKET?: string;
  MEDIA_S3_ACCESS_KEY_ID?: string;
  MEDIA_S3_SECRET_ACCESS_KEY?: string;
  MEDIA_S3_REGION?: string;
};

function s3Config(env: MediaEnvironment) {
  if (!env.MEDIA_S3_ENDPOINT || !env.MEDIA_S3_BUCKET || !env.MEDIA_S3_ACCESS_KEY_ID || !env.MEDIA_S3_SECRET_ACCESS_KEY) {
    throw new Error("Media storage is not configured.");
  }
  return {
    endpoint: env.MEDIA_S3_ENDPOINT.replace(/\/$/, ""),
    bucket: env.MEDIA_S3_BUCKET,
    client: new AwsClient({
      accessKeyId: env.MEDIA_S3_ACCESS_KEY_ID,
      secretAccessKey: env.MEDIA_S3_SECRET_ACCESS_KEY,
      region: env.MEDIA_S3_REGION ?? "auto",
      service: "s3",
    }),
  };
}

function s3Url(endpoint: string, bucket: string, key: string): string {
  return `${endpoint}/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export async function putMedia(env: MediaEnvironment, key: string, bytes: ArrayBuffer, contentType: string): Promise<void> {
  if (env.MEDIA) {
    await env.MEDIA.put(key, bytes, {httpMetadata: {contentType}});
    return;
  }
  const config = s3Config(env);
  const response = await config.client.fetch(s3Url(config.endpoint, config.bucket, key), {
    method: "PUT",
    headers: {"content-type": contentType},
    body: bytes,
  });
  if (!response.ok) throw new Error(`Media upload failed (${response.status}).`);
}

export type MediaRange = {start: number; end: number; total: number};

export async function getMedia(env: MediaEnvironment, key: string, range?: MediaRange): Promise<Response | null> {
  if (env.MEDIA) {
    const object = await env.MEDIA.get(key, range ? {range: {offset: range.start, length: range.end - range.start + 1}} : undefined);
    if (!object) return null;
    const responseHeaders = new Headers();
    if (object.httpMetadata?.contentType) responseHeaders.set("content-type", object.httpMetadata.contentType);
    responseHeaders.set("content-length", String(object.size));
    if (range) responseHeaders.set("content-range", `bytes ${range.start}-${range.end}/${range.total}`);
    return new Response(object.body, {status: range ? 206 : 200, headers: responseHeaders});
  }
  const config = s3Config(env);
  const response = await config.client.fetch(s3Url(config.endpoint, config.bucket, key), {
    headers: range ? {range: `bytes=${range.start}-${range.end}`} : undefined,
  });
  return response.status === 404 ? null : response;
}

export async function deleteMediaObject(env: MediaEnvironment, key: string): Promise<void> {
  if (env.MEDIA) {
    await env.MEDIA.delete(key);
    return;
  }
  const config = s3Config(env);
  const response = await config.client.fetch(s3Url(config.endpoint, config.bucket, key), {method: "DELETE"});
  if (!response.ok && response.status !== 404) throw new Error(`Media deletion failed (${response.status}).`);
}
