import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import type { ApiKeyPrincipal } from "@devpulse/contracts";
import { PlatformService } from "./platform.service.js";

export type AuthenticatedRequest = Request & { principal: ApiKeyPrincipal };

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(PlatformService) private readonly platform: PlatformService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const key = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : request.headers["x-api-key"];
    if (Array.isArray(key)) throw new UnauthorizedException("Invalid API key");
    request.principal = await this.platform.authenticate(key);
    return true;
  }
}

export async function principalFromRequest(
  platform: PlatformService,
  request: Request,
): Promise<ApiKeyPrincipal> {
  const authorization = request.headers.authorization;
  const key = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : request.headers["x-api-key"];
  if (Array.isArray(key)) throw new UnauthorizedException("Invalid API key");
  return platform.authenticate(key);
}
