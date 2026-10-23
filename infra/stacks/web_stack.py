"""Hosts the frontend on CloudFront and proxies the two AgentCore gateways under the same origin:

  /                    -> S3 (the React app)
  /research/*          -> agents gateway  (HTTP target `research`)
  /mcp                 -> tools gateway   (MCP endpoint)

Same-origin proxying means the browser never needs CORS from the gateways. Deploy this stack
after scripts/deploy_agentcore.py, which prints the gateway hosts to pass as context.
"""
from __future__ import annotations

from pathlib import Path

from aws_cdk import CfnOutput, Duration, RemovalPolicy, Stack
from aws_cdk import aws_cloudfront as cf
from aws_cdk import aws_cloudfront_origins as origins
from aws_cdk import aws_s3 as s3
from aws_cdk import aws_s3_deployment as s3deploy
from aws_cdk import aws_ssm as ssm
from constructs import Construct

from .base_stack import WEB_URL_PARAM, BaseStack

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "frontend" / "dist"


class WebStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, *, base: BaseStack, agents_gateway_host: str,
                 tools_gateway_host: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        site = s3.Bucket(self, "Site", block_public_access=s3.BlockPublicAccess.BLOCK_ALL, enforce_ssl=True,
                         encryption=s3.BucketEncryption.S3_MANAGED, removal_policy=RemovalPolicy.DESTROY, auto_delete_objects=True)

        # Forward exactly what the gateways need. CloudFront strips Authorization from origin
        # requests unless it is part of a cache policy's key, so it goes there; every gateway call
        # is a POST, which CloudFront never caches, so nothing is ever served from cache.
        # Host is not forwarded, so each gateway sees its own host name.
        gateway_cache = cf.CachePolicy(
            self, "GatewayAuthKey",
            comment="God Eye: carries Authorization to AgentCore gateways (POST only, never cached)",
            header_behavior=cf.CacheHeaderBehavior.allow_list("Authorization"),
            query_string_behavior=cf.CacheQueryStringBehavior.none(),
            cookie_behavior=cf.CacheCookieBehavior.none(),
            min_ttl=Duration.seconds(0), default_ttl=Duration.seconds(0), max_ttl=Duration.seconds(1),
        )
        gateway_headers = cf.OriginRequestPolicy(
            self, "GatewayHeaders",
            comment="God Eye: other headers forwarded to AgentCore gateways",
            header_behavior=cf.OriginRequestHeaderBehavior.allow_list(
                "Content-Type", "Accept", "Mcp-Session-Id", "Mcp-Protocol-Version",
                "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id", "X-Amzn-Trace-Id"),
            query_string_behavior=cf.OriginRequestQueryStringBehavior.all(),
            cookie_behavior=cf.OriginRequestCookieBehavior.none(),
        )
        api_behavior = dict(
            viewer_protocol_policy=cf.ViewerProtocolPolicy.HTTPS_ONLY,
            allowed_methods=cf.AllowedMethods.ALLOW_ALL,
            cache_policy=gateway_cache,
            origin_request_policy=gateway_headers,
        )
        gateway_origin = lambda host: origins.HttpOrigin(  # noqa: E731
            host, protocol_policy=cf.OriginProtocolPolicy.HTTPS_ONLY, read_timeout=Duration.seconds(60),
            keepalive_timeout=Duration.seconds(60))

        dist = cf.Distribution(
            self, "Web",
            comment="God Eye Researcher",
            default_root_object="index.html",
            default_behavior=cf.BehaviorOptions(
                origin=origins.S3BucketOrigin.with_origin_access_control(site),
                viewer_protocol_policy=cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cache_policy=cf.CachePolicy.CACHING_OPTIMIZED,
                response_headers_policy=cf.ResponseHeadersPolicy.SECURITY_HEADERS,
            ),
            additional_behaviors={
                "/research/*": cf.BehaviorOptions(origin=gateway_origin(agents_gateway_host), **api_behavior),
                "/mcp": cf.BehaviorOptions(origin=gateway_origin(tools_gateway_host), **api_behavior),
            },
            minimum_protocol_version=cf.SecurityPolicyProtocol.TLS_V1_2_2021,
        )

        config = {
            "mode": "live",
            "region": base.region,
            "userPoolId": base.user_pool.user_pool_id,
            "userPoolClientId": base.user_pool_client.user_pool_client_id,
            "eventsHttpEndpoint": f"https://{base.events.http_dns}/event",
            "agentsBaseUrl": "",
            "toolsMcpUrl": "/mcp",
            "emailNotifications": base.email_notifications,
        }
        sources = [s3deploy.Source.json_data("config.json", config)]
        if DIST.exists():
            sources.insert(0, s3deploy.Source.asset(str(DIST), exclude=["config.json"]))
        s3deploy.BucketDeployment(self, "DeploySite", destination_bucket=site, sources=sources,
                                  distribution=dist, distribution_paths=["/index.html", "/config.json"], prune=True)

        CfnOutput(self, "WebUrl", value=f"https://{dist.distribution_domain_name}")
        # The end-of-run email links here (tools/src/common/notify.py).
        ssm.StringParameter(self, "WebUrlParameter", parameter_name=WEB_URL_PARAM,
                            string_value=f"https://{dist.distribution_domain_name}")
