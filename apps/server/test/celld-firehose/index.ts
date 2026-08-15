import {Firehose} from "../../src/index";

interface Env {
  FIREHOSE: DurableObjectNamespace;
}

export {Firehose};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const id = env.FIREHOSE.idFromName("integration");
    const stub = env.FIREHOSE.get(id);

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket" && url.pathname === "/firehose") {
      return stub.fetch(request);
    }
    if (request.method === "POST" && url.pathname === "/broadcast") {
      await stub.fetch("https://firehose/broadcast", {method: "POST", body: await request.text()});
      return new Response("ok");
    }
    return new Response("not found", {status: 404});
  },
};
