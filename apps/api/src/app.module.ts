import { Module } from "@nestjs/common";
import { ApolloDriver, type ApolloDriverConfig } from "@nestjs/apollo";
import { GraphQLModule } from "@nestjs/graphql";
import type { Request } from "express";
import { GraphQLError, type ValidationRule } from "graphql";
import { loadConfig } from "./config.js";
import { PlatformService } from "./platform.service.js";
import { RUNTIME_CONFIG } from "./tokens.js";
import { ApiController } from "./api.controller.js";
import { PlatformResolver } from "./platform.resolver.js";
import { ApiKeyGuard } from "./security.js";

const config = loadConfig();

const boundedGraphqlQueryRule: ValidationRule = (context) => {
  let fieldCount = 0;
  let selectionDepth = 0;
  let reported = false;
  return {
    SelectionSet: {
      enter(node) {
        selectionDepth += 1;
        if (selectionDepth > 6 && !reported) {
          reported = true;
          context.reportError(
            new GraphQLError("GraphQL query exceeds the maximum field count or depth", {
              nodes: [node],
            }),
          );
        }
      },
      leave() {
        selectionDepth -= 1;
      },
    },
    Field(node) {
      fieldCount += 1;
      if (fieldCount > 60 && !reported) {
        reported = true;
        context.reportError(
          new GraphQLError("GraphQL query exceeds the maximum field count or depth", {
            nodes: [node],
          }),
        );
      }
    },
  };
};

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      path: "/graphql",
      sortSchema: true,
      playground: false,
      introspection: config.environment !== "production",
      includeStacktraceInErrorResponses: config.environment !== "production",
      context: ({ req }: { req: Request }) => ({ req }),
      csrfPrevention: true,
      validationRules: [boundedGraphqlQueryRule],
    }),
  ],
  controllers: [ApiController],
  providers: [
    { provide: RUNTIME_CONFIG, useValue: config },
    PlatformService,
    PlatformResolver,
    ApiKeyGuard,
  ],
})
export class AppModule {}
