import { z } from 'zod';
import { API_PREFIX, CONTRACT_VERSION } from './common.ts';
import { Problem } from './errors.ts';
import { routeList } from './routes.ts';
import type { RouteSpec } from './route-def.ts';

type Json = Record<string, unknown>;

/** 由 contracts 生成 OpenAPI 3.1（JSON Schema 2020-12）。产物提交在 packages/contracts/openapi.json，测试保证与源一致。 */
export function buildOpenApi(): Json {
  const components: Record<string, Json> = {};
  const conv = (schema: z.ZodType, io: 'input' | 'output'): Json => {
    const sfx = io === 'input' ? 'Input' : '';
    const js = z.toJSONSchema(schema, { io, unrepresentable: 'any', reused: 'inline' }) as Json;
    const rewrite = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(rewrite);
      if (node && typeof node === 'object') {
        const out: Json = {};
        for (const [k, v] of Object.entries(node as Json)) {
          if (k === '$ref' && typeof v === 'string' && v.startsWith('#/$defs/'))
            out[k] = `#/components/schemas/${v.slice(8)}${sfx}`;
          else if (k === 'id' && typeof v === 'string') continue;
          else out[k] = rewrite(v);
        }
        return out;
      }
      return node;
    };
    const defs = (js.$defs ?? {}) as Record<string, Json>;
    for (const [k, v] of Object.entries(defs)) components[`${k}${sfx}`] = rewrite(v) as Json;
    delete js.$defs;
    delete js.$schema;
    return rewrite(js) as Json;
  };
  const objParams = (schema: z.ZodType | undefined, where: 'path' | 'query'): Json[] => {
    if (!schema) return [];
    const js = conv(schema, 'input');
    const props = (js.properties ?? {}) as Record<string, Json>;
    const req = new Set((js.required ?? []) as string[]);
    return Object.entries(props).map(([name, s]) => ({
      name,
      in: where,
      required: where === 'path' || req.has(name),
      schema: s,
    }));
  };
  const paths: Record<string, Record<string, Json>> = {};
  for (const r of routeList as readonly RouteSpec[]) {
    const p = API_PREFIX + r.path.replace(/:([A-Za-z]+)/g, '{$1}');
    const params = [...objParams(r.params, 'path'), ...objParams(r.query, 'query')];
    if (r.idempotency)
      params.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: r.idempotency === 'required',
        schema: { type: 'string', minLength: 8, maxLength: 80 },
      });
    if (r.ifMatch)
      params.push({
        name: 'If-Match',
        in: 'header',
        required: true,
        schema: { type: 'string' },
        description: 'rowVersion',
      });
    const responses: Record<string, Json> = {};
    for (const [code, schema] of Object.entries(r.responses)) {
      if (schema)
        responses[code] = {
          description: 'OK',
          content: { [r.produces ?? 'application/json']: { schema: conv(schema, 'output') } },
        };
      else if (r.produces && r.produces !== 'application/json' && code === '200')
        responses[code] = {
          description: 'OK',
          content: { [r.produces]: { schema: { type: 'string', format: 'binary' } } },
        };
      else responses[code] = { description: code === '304' ? 'Not Modified' : 'No Content' };
    }
    responses.default = {
      description: 'RFC 9457 problem',
      content: { 'application/problem+json': { schema: conv(Problem, 'output') } },
    };
    const op: Json = {
      operationId: r.id,
      summary: r.summary,
      tags: [r.tag],
      parameters: params,
      responses,
      security: r.roles === 'public' ? [] : [{ bearer: [] }],
      'x-roles': r.roles,
      'x-scope': r.scope,
      'x-owner': r.owner,
      ...(r.policy ? { 'x-policy': r.policy } : {}),
      ...(r.errors ? { 'x-errors': r.errors } : {}),
      ...(r.checksDevice ? { 'x-checks-device': true } : {}),
      ...(r.etag ? { 'x-etag': true } : {}),
    };
    if (r.body)
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: conv(r.body, 'input') } },
      };
    else if (r.consumes === 'multipart/form-data')
      op.requestBody = {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: { file: { type: 'string', format: 'binary' } },
              required: ['file'],
            },
          },
        },
      };
    (paths[p] ??= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'wms3d API',
      version: CONTRACT_VERSION,
      description: 'contract-v1（冻结）。源：packages/contracts（Zod 4）。',
    },
    servers: [{ url: '/' }],
    paths,
    components: {
      schemas: Object.fromEntries(
        Object.entries(components).sort(([a], [b]) => a.localeCompare(b)),
      ),
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    },
  };
}
