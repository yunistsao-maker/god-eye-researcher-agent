"""Everything except AgentCore resources: data stores, auth, events, tool Lambdas, cleanup workflow,
and the IAM roles the gateways and the runtime assume. AgentCore gateways and the runtime are
created by scripts/deploy_agentcore.py using the outputs of this stack."""
from __future__ import annotations

from pathlib import Path

from aws_cdk import (
    CfnOutput,
    Duration,
    RemovalPolicy,
    Stack,
    aws_appsync as appsync,
    aws_cognito as cognito,
    aws_dynamodb as ddb,
    aws_iam as iam,
    aws_lambda as lambda_,
    aws_logs as logs,
    aws_s3 as s3,
    aws_ssm as ssm,
    aws_stepfunctions as sfn,
    aws_stepfunctions_tasks as tasks,
)
from constructs import Construct

ROOT = Path(__file__).resolve().parents[2]
TOOLS_SRC = str(ROOT / "tools" / "src")
RUNTIME_ARN_PARAM = "/god-eye-researcher/research-runtime-arn"
WEB_URL_PARAM = "/god-eye-researcher/web-url"   # written by WebStack; read when an end-of-run email links to the app


class BaseStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)
        destroy = self.node.try_get_context("destroyOnDelete") == "true"
        removal = RemovalPolicy.DESTROY if destroy else RemovalPolicy.RETAIN
        archive_days = int(self.node.try_get_context("archiveTtlDays") or 30)

        # ---------- data ----------
        self.data_bucket = s3.Bucket(
            self, "ResearchData",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            removal_policy=removal,
            auto_delete_objects=destroy,
            lifecycle_rules=[
                s3.LifecycleRule(id="expire-archived-projects", tag_filters={"status": "archived"}, expiration=Duration.days(archive_days)),
                s3.LifecycleRule(id="archives-to-glacier", prefix="archive/",
                                 transitions=[s3.Transition(storage_class=s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transition_after=Duration.days(7))]),
            ],
        )
        self.artifacts_bucket = s3.Bucket(
            self, "AgentArtifacts",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            versioned=True,
            removal_policy=removal,
            auto_delete_objects=destroy,
        )
        self.table = ddb.TableV2(
            self, "ResearchTable",
            partition_key=ddb.Attribute(name="PK", type=ddb.AttributeType.STRING),
            sort_key=ddb.Attribute(name="SK", type=ddb.AttributeType.STRING),
            billing=ddb.Billing.on_demand(),
            time_to_live_attribute="expiresAt",
            point_in_time_recovery_specification=ddb.PointInTimeRecoverySpecification(point_in_time_recovery_enabled=True),
            removal_policy=removal,
        )

        # ---------- auth ----------
        self.user_pool = cognito.UserPool(
            self, "Users",
            self_sign_up_enabled=False,
            sign_in_aliases=cognito.SignInAliases(email=True),
            password_policy=cognito.PasswordPolicy(min_length=12),
            removal_policy=removal,
        )
        self.user_pool_client = self.user_pool.add_client(
            "WebClient",
            generate_secret=False,
            auth_flows=cognito.AuthFlow(user_srp=True),
            access_token_validity=Duration.hours(1),
            id_token_validity=Duration.hours(1),
            refresh_token_validity=Duration.days(7),
        )
        discovery_url = f"https://cognito-idp.{self.region}.amazonaws.com/{self.user_pool.user_pool_id}/.well-known/openid-configuration"

        # ---------- realtime events ----------
        self.events = appsync.EventApi(
            self, "ResearchEvents",
            api_name="god-eye-research-events",
            authorization_config=appsync.EventApiAuthConfig(
                auth_providers=[
                    appsync.AppSyncAuthProvider(authorization_type=appsync.AppSyncAuthorizationType.USER_POOL,
                                                cognito_config=appsync.AppSyncCognitoConfig(user_pool=self.user_pool)),
                    appsync.AppSyncAuthProvider(authorization_type=appsync.AppSyncAuthorizationType.IAM),
                ],
                connection_auth_mode_types=[appsync.AppSyncAuthorizationType.USER_POOL, appsync.AppSyncAuthorizationType.IAM],
                default_publish_auth_mode_types=[appsync.AppSyncAuthorizationType.IAM],
                default_subscribe_auth_mode_types=[appsync.AppSyncAuthorizationType.USER_POOL],
            ),
            log_config=appsync.AppSyncLogConfig(field_log_level=appsync.AppSyncFieldLogLevel.ERROR, retention=logs.RetentionDays.ONE_MONTH),
        )
        self.events.add_channel_namespace("Research", channel_namespace_name="research")

        # ---------- parameters ----------
        runtime_param = ssm.StringParameter(
            self, "ResearchRuntimeArnParameter", parameter_name=RUNTIME_ARN_PARAM, string_value="not-deployed-yet",
            description="ARN of the research AgentCore Runtime, written by scripts/deploy_agentcore.py",
        )

        # ---------- tool Lambdas ----------
        code = lambda_.Code.from_asset(TOOLS_SRC, exclude=["**/__pycache__", "**/*.pyc"])
        common_env = {
            "TABLE_NAME": self.table.table_name,
            "BUCKET_NAME": self.data_bucket.bucket_name,
            "EVENTS_HTTP_DOMAIN": self.events.http_dns,
        }

        def fn(name: str, handler: str, timeout: int = 30, memory: int = 512, env: dict | None = None) -> lambda_.Function:
            f = lambda_.Function(
                self, name,
                runtime=lambda_.Runtime.PYTHON_3_12,
                architecture=lambda_.Architecture.ARM_64,
                handler=handler,
                code=code,
                timeout=Duration.seconds(timeout),
                memory_size=memory,
                environment={**common_env, **(env or {})},
                log_group=logs.LogGroup(self, f"{name}Logs", retention=logs.RetentionDays.ONE_MONTH, removal_policy=RemovalPolicy.DESTROY),
            )
            return f

        cleanup_fn = fn("CleanupStep", "cleanup.handler", timeout=300, memory=1024,
                        env={"RUNTIME_ARN_PARAM": RUNTIME_ARN_PARAM, "ARCHIVE_TTL_DAYS": str(archive_days)})
        self.table.grant_read_write_data(cleanup_fn)
        self.data_bucket.grant_read_write(cleanup_fn)
        cleanup_fn.add_to_role_policy(iam.PolicyStatement(actions=["s3:PutObjectTagging"], resources=[self.data_bucket.arn_for_objects("projects/*")]))
        runtime_param.grant_read(cleanup_fn)
        cleanup_fn.add_to_role_policy(iam.PolicyStatement(
            actions=["bedrock-agentcore:StopRuntimeSession"],
            resources=[f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:runtime/*"]))
        self.events.grant_publish(cleanup_fn)

        steps = ["stop_session", "export_archive", "tag_objects", "set_ttl", "delete_vectors", "publish_archived"]
        chain: sfn.IChainable | None = None
        for step in steps:
            task = tasks.LambdaInvoke(
                self, f"Cleanup-{step}",
                lambda_function=cleanup_fn,
                payload=sfn.TaskInput.from_object({
                    "step": step,
                    "projectId": sfn.JsonPath.string_at("$.projectId"),
                    "owner": sfn.JsonPath.string_at("$.owner"),
                }),
                payload_response_only=True,
                result_selector={"projectId.$": "$.projectId", "owner.$": "$.owner"},
            )
            task.add_retry(errors=["States.ALL"], max_attempts=3, interval=Duration.seconds(5), backoff_rate=2)
            chain = task if chain is None else chain.next(task)  # type: ignore[union-attr]
        self.cleanup_machine = sfn.StateMachine(
            self, "ProjectCleanup",
            definition_body=sfn.DefinitionBody.from_chainable(chain),
            timeout=Duration.minutes(30),
            tracing_enabled=True,
        )

        # Optional end-of-run email (project_notify): -c notifyFromEmail=research@example.com, an address or domain
        # already verified in Amazon SES in this region (and out of the SES sandbox to reach unverified recipients).
        notify_from = self.node.try_get_context("notifyFromEmail") or ""
        self.email_notifications = bool(notify_from)
        project_env = {"CLEANUP_STATE_MACHINE_ARN": self.cleanup_machine.state_machine_arn}
        if notify_from:
            project_env.update({"NOTIFY_FROM": notify_from, "USER_POOL_ID": self.user_pool.user_pool_id, "WEB_URL_PARAM": WEB_URL_PARAM})
        project_fn = fn("ProjectTools", "project_tools.handler", env=project_env)
        if notify_from:
            project_fn.add_to_role_policy(iam.PolicyStatement(
                actions=["ses:SendEmail"], resources=[f"arn:aws:ses:{self.region}:{self.account}:identity/*"],
                conditions={"StringEquals": {"ses:FromAddress": notify_from.split("<")[-1].rstrip(">").strip()}}))
            project_fn.add_to_role_policy(iam.PolicyStatement(actions=["cognito-idp:ListUsers"], resources=[self.user_pool.user_pool_arn]))
            project_fn.add_to_role_policy(iam.PolicyStatement(
                actions=["ssm:GetParameter"], resources=[f"arn:aws:ssm:{self.region}:{self.account}:parameter{WEB_URL_PARAM}"]))
        data_fn = fn("DataTools", "data_tools.handler")
        # Optional second search index / extractor (Tavily or Exa): pass an existing Secrets Manager secret holding
        # {"provider": "tavily" | "exa", "apiKey": "..."} with -c searchSecretArn=arn:aws:secretsmanager:...
        search_secret_arn = self.node.try_get_context("searchSecretArn") or ""
        web_env = {"RESPECT_ROBOTS": "true", "BLOCKED_DOMAINS": self.node.try_get_context("blockedDomains") or ""}
        if search_secret_arn:
            web_env["SEARCH_SECRET_ARN"] = search_secret_arn
        # fetch_page registers each page as a project document (DynamoDB + S3 snapshot) and announces it.
        web_fn = fn("WebTools", "web_tools.handler", timeout=60, memory=1024, env=web_env)
        self.table.grant_read_write_data(web_fn)
        self.data_bucket.grant_read_write(web_fn)
        self.events.grant_publish(web_fn)
        if search_secret_arn:
            web_fn.add_to_role_policy(iam.PolicyStatement(
                actions=["secretsmanager:GetSecretValue"], resources=[search_secret_arn, f"{search_secret_arn}-??????"]))
        interceptor_fn = fn("ToolsInterceptor", "interceptor.handler", timeout=10, memory=256)

        for f in (project_fn, data_fn):
            self.table.grant_read_write_data(f)
            self.data_bucket.grant_read_write(f)
            self.events.grant_publish(f)
        self.cleanup_machine.grant_start_execution(project_fn)

        # ---------- roles for AgentCore (used by scripts/deploy_agentcore.py) ----------
        agentcore = iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", conditions={
            "StringEquals": {"aws:SourceAccount": self.account},
            "ArnLike": {"aws:SourceArn": f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:*"},
        })
        self.gateway_role = iam.Role(self, "GatewayRole", assumed_by=agentcore,
                                     description="Execution role for the god-eye agents and tools gateways")
        for f in (project_fn, data_fn, web_fn, interceptor_fn):
            f.grant_invoke(self.gateway_role)
        self.gateway_role.add_to_policy(iam.PolicyStatement(
            actions=["bedrock-agentcore:InvokeAgentRuntime"],
            resources=[f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:runtime/*"]))
        # Managed AgentCore Web Search connector (target `web-search` on the tools gateway).
        self.gateway_role.add_to_policy(iam.PolicyStatement(
            actions=["bedrock-agentcore:InvokeGateway"],
            resources=[f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:gateway/*"]))
        self.gateway_role.add_to_policy(iam.PolicyStatement(
            actions=["bedrock-agentcore:InvokeWebSearch"],
            resources=[f"arn:aws:bedrock-agentcore:{self.region}:aws:tool/web-search.v1"]))

        self.runtime_role = iam.Role(self, "RuntimeRole", assumed_by=agentcore,
                                     description="Execution role for the research supervisor runtime")
        self.runtime_role.add_to_policy(iam.PolicyStatement(
            # The Converse APIs are authorized by these two actions.
            actions=["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
            resources=["arn:aws:bedrock:*::foundation-model/*", f"arn:aws:bedrock:*:{self.account}:inference-profile/*"]))
        self.runtime_role.add_to_policy(iam.PolicyStatement(
            actions=["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "logs:DescribeLogGroups"],
            resources=[f"arn:aws:logs:{self.region}:{self.account}:log-group:/aws/bedrock-agentcore/*"]))
        self.runtime_role.add_to_policy(iam.PolicyStatement(
            actions=["xray:PutTraceSegments", "xray:PutTelemetryRecords", "cloudwatch:PutMetricData"], resources=["*"]))
        self.artifacts_bucket.grant_read(self.runtime_role)
        # Live progress (agent.activity, agent.heartbeat, agent.stalled, synthesis.delta) goes straight
        # from the runtime to AppSync; persisted data still goes through the tools gateway.
        self.events.grant_publish(self.runtime_role)

        # ---------- outputs ----------
        outputs = {
            "Region": self.region,
            "TableName": self.table.table_name,
            "DataBucket": self.data_bucket.bucket_name,
            "ArtifactsBucket": self.artifacts_bucket.bucket_name,
            "UserPoolId": self.user_pool.user_pool_id,
            "UserPoolClientId": self.user_pool_client.user_pool_client_id,
            "DiscoveryUrl": discovery_url,
            "EventsHttpDomain": self.events.http_dns,
            "EventsRealtimeDomain": self.events.realtime_dns,
            "ProjectToolsArn": project_fn.function_arn,
            "DataToolsArn": data_fn.function_arn,
            "WebToolsArn": web_fn.function_arn,
            "InterceptorArn": interceptor_fn.function_arn,
            "GatewayRoleArn": self.gateway_role.role_arn,
            "RuntimeRoleArn": self.runtime_role.role_arn,
            "RuntimeArnParam": RUNTIME_ARN_PARAM,
            "CleanupStateMachineArn": self.cleanup_machine.state_machine_arn,
            "SecondarySearch": "on" if search_secret_arn else "off",
            "EmailNotifications": "on" if notify_from else "off",
        }
        for key, value in outputs.items():
            CfnOutput(self, key, value=value)
