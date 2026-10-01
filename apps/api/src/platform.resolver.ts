import { BadRequestException, Inject } from "@nestjs/common";
import {
  Args,
  Context,
  Field,
  ID,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from "@nestjs/graphql";
import type { Request } from "express";
import { PlatformService } from "./platform.service.js";
import { principalFromRequest } from "./security.js";

type GraphqlContext = { req: Request };

@ObjectType()
class EndpointObject {
  @Field(() => ID) id!: string;
  @Field() url!: string;
  @Field() description!: string;
  @Field() enabled!: boolean;
  @Field(() => [String]) eventTypes!: string[];
  @Field(() => Int) timeoutMs!: number;
  @Field() retryPolicyJson!: string;
  @Field() createdAt!: string;
  @Field() updatedAt!: string;
}

@ObjectType()
class DeliveryObject {
  @Field(() => ID) id!: string;
  @Field() eventId!: string;
  @Field() endpointId!: string;
  @Field() eventType!: string;
  @Field() status!: string;
  @Field(() => Int) attemptCount!: number;
  @Field(() => String, { nullable: true }) nextAttemptAt!: string | null;
  @Field() createdAt!: string;
}

@ObjectType()
class HealthObject {
  @Field() status!: string;
  @Field() database!: string;
  @Field(() => Int, { nullable: true }) outboxPending!: number | null;
  @Field(() => String, { nullable: true }) workerHeartbeatAt!: string | null;
}

@ObjectType()
class CreatedEndpointObject {
  @Field(() => EndpointObject) endpoint!: EndpointObject;
  @Field() signingSecret!: string;
}

@ObjectType()
class AttemptObject {
  @Field(() => ID) id!: string;
  @Field(() => Int) attemptNumber!: number;
  @Field() startedAt!: string;
  @Field(() => String, { nullable: true }) completedAt!: string | null;
  @Field(() => Int, { nullable: true }) httpStatus!: number | null;
  @Field(() => Int, { nullable: true }) durationMs!: number | null;
  @Field(() => String, { nullable: true }) responseExcerpt!: string | null;
  @Field(() => String, { nullable: true }) errorCategory!: string | null;
  @Field(() => String, { nullable: true }) nextAttemptAt!: string | null;
}

@ObjectType()
class ApiKeyObject {
  @Field(() => ID) id!: string;
  @Field() name!: string;
  @Field() prefix!: string;
  @Field(() => [String]) scopes!: string[];
  @Field() createdAt!: string;
  @Field(() => String, { nullable: true }) revokedAt!: string | null;
  @Field(() => String, { nullable: true }) lastUsedAt!: string | null;
  @Field() current!: boolean;
}

@ObjectType()
class CreatedApiKeyObject {
  @Field() key!: string;
  @Field(() => ApiKeyObject) record!: ApiKeyObject;
}

@ObjectType()
class DeliveryActionObject {
  @Field() deliveryId!: string;
  @Field() duplicate!: boolean;
}

@Resolver()
export class PlatformResolver {
  constructor(@Inject(PlatformService) private readonly platform: PlatformService) {}

  @Query(() => [EndpointObject])
  async endpoints(@Context() context: GraphqlContext): Promise<EndpointObject[]> {
    const principal = await principalFromRequest(this.platform, context.req);
    return (await this.platform.endpoints(principal)).map(asEndpointObject);
  }

  @Query(() => [DeliveryObject])
  async deliveries(@Context() context: GraphqlContext): Promise<DeliveryObject[]> {
    const principal = await principalFromRequest(this.platform, context.req);
    return this.platform.deliveries(principal);
  }

  @Query(() => HealthObject)
  async health(@Context() context: GraphqlContext): Promise<HealthObject> {
    await principalFromRequest(this.platform, context.req);
    return this.platform.health();
  }

  @Query(() => [ApiKeyObject])
  async apiKeys(@Context() context: GraphqlContext): Promise<ApiKeyObject[]> {
    const principal = await principalFromRequest(this.platform, context.req);
    return this.platform.apiKeys(principal);
  }

  @Query(() => [AttemptObject])
  async deliveryAttempts(
    @Context() context: GraphqlContext,
    @Args("deliveryId", { type: () => ID }) deliveryId: string,
  ): Promise<AttemptObject[]> {
    const principal = await principalFromRequest(this.platform, context.req);
    return this.platform.deliveryAttempts(principal, deliveryId);
  }

  @Mutation(() => CreatedEndpointObject)
  async createEndpoint(
    @Context() context: GraphqlContext,
    @Args("url") url: string,
    @Args("eventTypes", { type: () => [String] }) eventTypes: string[],
    @Args("description", { nullable: true }) description?: string,
  ): Promise<CreatedEndpointObject> {
    const principal = await principalFromRequest(this.platform, context.req);
    const result = await this.platform.createEndpoint(principal, { url, eventTypes, description });
    return { endpoint: asEndpointObject(result.endpoint), signingSecret: result.signingSecret };
  }

  @Mutation(() => EndpointObject)
  async updateEndpoint(
    @Context() context: GraphqlContext,
    @Args("id", { type: () => ID }) id: string,
    @Args("enabled", { nullable: true }) enabled?: boolean,
    @Args("url", { nullable: true }) url?: string,
    @Args("description", { nullable: true }) description?: string,
    @Args("timeoutMs", { type: () => Int, nullable: true }) timeoutMs?: number,
  ): Promise<EndpointObject> {
    const changes = { enabled, url, description, timeoutMs };
    if (Object.values(changes).every((value) => value === undefined))
      throw new BadRequestException("At least one endpoint field must be provided");
    const principal = await principalFromRequest(this.platform, context.req);
    return asEndpointObject(await this.platform.updateEndpoint(principal, id, changes));
  }

  @Mutation(() => CreatedApiKeyObject)
  async issueApiKey(
    @Context() context: GraphqlContext,
    @Args("name") name: string,
  ): Promise<CreatedApiKeyObject> {
    const principal = await principalFromRequest(this.platform, context.req);
    return this.platform.issueApiKey(principal, name);
  }

  @Mutation(() => Boolean)
  async revokeApiKey(
    @Context() context: GraphqlContext,
    @Args("id", { type: () => ID }) id: string,
  ): Promise<boolean> {
    const principal = await principalFromRequest(this.platform, context.req);
    return this.platform.revokeApiKey(principal, id);
  }

  @Mutation(() => String)
  async rotateEndpointSecret(
    @Context() context: GraphqlContext,
    @Args("endpointId", { type: () => ID }) endpointId: string,
  ): Promise<string> {
    const principal = await principalFromRequest(this.platform, context.req);
    return this.platform.rotateEndpointSecret(principal, endpointId);
  }

  @Mutation(() => Boolean)
  async deleteEndpoint(
    @Context() context: GraphqlContext,
    @Args("endpointId", { type: () => ID }) endpointId: string,
  ): Promise<boolean> {
    const principal = await principalFromRequest(this.platform, context.req);
    return this.platform.deleteEndpoint(principal, endpointId);
  }

  @Mutation(() => DeliveryActionObject)
  async retryDelivery(
    @Context() context: GraphqlContext,
    @Args("deliveryId", { type: () => ID }) deliveryId: string,
    @Args("idempotencyKey") idempotencyKey: string,
  ): Promise<DeliveryActionObject> {
    const principal = await principalFromRequest(this.platform, context.req);
    return this.platform.retryDelivery(principal, deliveryId, idempotencyKey, "retry");
  }

  @Mutation(() => DeliveryActionObject)
  async replayDelivery(
    @Context() context: GraphqlContext,
    @Args("deliveryId", { type: () => ID }) deliveryId: string,
    @Args("idempotencyKey") idempotencyKey: string,
  ): Promise<DeliveryActionObject> {
    const principal = await principalFromRequest(this.platform, context.req);
    return this.platform.retryDelivery(principal, deliveryId, idempotencyKey, "replay");
  }
}

function asEndpointObject(
  endpoint: Awaited<ReturnType<PlatformService["endpoints"]>>[number],
): EndpointObject {
  return { ...endpoint, retryPolicyJson: JSON.stringify(endpoint.retryPolicy) };
}
