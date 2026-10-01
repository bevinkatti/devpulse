import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  Res,
  Req,
  UnauthorizedException,
  Catch,
  HttpException,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import type { Request, Response } from "express";
import { PlatformService } from "./platform.service.js";
import { ApiKeyGuard, type AuthenticatedRequest } from "./security.js";
import { RUNTIME_CONFIG } from "./tokens.js";
import type { RuntimeConfig } from "./config.js";

@Controller()
export class ApiController {
  constructor(
    @Inject(PlatformService) private readonly platform: PlatformService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  @Get("health/live")
  live() {
    return { status: "ok" };
  }

  @Get("health/ready")
  async ready(@Res() response: Response) {
    const health = await this.platform.health();
    response.status(health.database === "ok" ? 200 : 503).json(health);
    return;
  }

  @Post("v1/tenants")
  @HttpCode(201)
  async createTenant(
    @Headers("x-bootstrap-token") token: string | undefined,
    @Body() body: unknown,
  ) {
    if (!constantStringEquals(token ?? "", this.config.apiBootstrapToken))
      throw new UnauthorizedException("Invalid bootstrap token");
    const record = body as { name?: unknown } | null;
    if (
      !record ||
      typeof record.name !== "string" ||
      record.name.trim().length < 1 ||
      record.name.trim().length > 160
    ) {
      throw new BadRequestException("Tenant name must be 1 to 160 characters");
    }
    return this.platform.createTenant(record.name.trim());
  }

  @Post("v1/events")
  @HttpCode(202)
  @UseGuards(ApiKeyGuard)
  ingest(
    @Req() request: AuthenticatedRequest,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.platform.ingest(request.principal, key, body);
  }

  @Get("v1/endpoints")
  @UseGuards(ApiKeyGuard)
  endpoints(@Req() request: AuthenticatedRequest) {
    return this.platform.endpoints(request.principal);
  }

  @Post("v1/endpoints")
  @HttpCode(201)
  @UseGuards(ApiKeyGuard)
  createEndpoint(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.platform.createEndpoint(request.principal, body);
  }

  @Post("v1/endpoints/update")
  @UseGuards(ApiKeyGuard)
  updateEndpoint(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = body as { id?: unknown; changes?: unknown } | null;
    if (!input || typeof input.id !== "string")
      throw new BadRequestException("Endpoint ID is required");
    return this.platform.updateEndpoint(request.principal, input.id, input.changes);
  }

  @Get("v1/deliveries")
  @UseGuards(ApiKeyGuard)
  deliveries(@Req() request: AuthenticatedRequest) {
    return this.platform.deliveries(request.principal);
  }

  @Get("v1/request-id")
  requestId(@Req() request: Request) {
    return { requestId: request.headers["x-request-id"] ?? randomUUID() };
  }
}

@Catch()
class SafeExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const requestId = (request.headers["x-request-id"] as string | undefined) ?? randomUUID();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const raw = exception instanceof HttpException ? exception.getResponse() : undefined;
    const rawMessage =
      typeof raw === "object" && raw !== null && "message" in raw ? raw.message : undefined;
    const message =
      typeof raw === "string"
        ? raw
        : typeof rawMessage === "string"
          ? rawMessage
          : "Request failed";
    const details = Array.isArray(rawMessage)
      ? rawMessage.slice(0, 20).map((item: unknown) => {
          if (typeof item !== "object" || item === null)
            return { path: "", message: "Invalid value" };
          const issue = item as {
            path?: unknown;
            message?: unknown;
            property?: unknown;
            constraints?: unknown;
          };
          if (Array.isArray(issue.path) && typeof issue.message === "string") {
            return { path: issue.path.join("."), message: issue.message };
          }
          const constraints =
            typeof issue.constraints === "object" && issue.constraints !== null
              ? Object.values(issue.constraints as Record<string, unknown>)
                  .filter((value): value is string => typeof value === "string")
                  .join(", ")
              : "Invalid value";
          return {
            path: typeof issue.property === "string" ? issue.property : "",
            message: constraints,
          };
        })
      : undefined;
    console.error(
      JSON.stringify({ event: "http.request.failed", requestId, status, path: request.path }),
    );
    response.status(status).json({
      error: {
        code:
          status === 401
            ? "UNAUTHENTICATED"
            : status === 403
              ? "FORBIDDEN"
              : status === 429
                ? "RATE_LIMITED"
                : status < 500
                  ? "INVALID_REQUEST"
                  : "INTERNAL_ERROR",
        message: status < 500 ? message : "Internal server error",
        requestId,
        ...(details ? { details } : {}),
      },
    });
  }
}

UseFilters(SafeExceptionFilter)(ApiController);

function constantStringEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
