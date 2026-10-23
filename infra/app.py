#!/usr/bin/env python3
"""CDK app.

  cdk deploy GodEyeBase                         # data, auth, events, tool Lambdas, roles
  python ../scripts/deploy_agentcore.py         # gateways + research runtime (prints the hosts)
  cdk deploy GodEyeWeb -c agentsGatewayHost=… -c toolsGatewayHost=…
"""
import os

import aws_cdk as cdk

from stacks.base_stack import BaseStack
from stacks.web_stack import WebStack

app = cdk.App()
env = cdk.Environment(account=os.environ.get("CDK_DEFAULT_ACCOUNT"), region=os.environ.get("CDK_DEFAULT_REGION", "us-west-2"))

base = BaseStack(app, "GodEyeBase", env=env, description="God Eye Researcher: data, auth, events, gateway tools")

agents_host = app.node.try_get_context("agentsGatewayHost")
tools_host = app.node.try_get_context("toolsGatewayHost")
if agents_host and tools_host:
    WebStack(app, "GodEyeWeb", env=env, base=base, agents_gateway_host=agents_host, tools_gateway_host=tools_host,
             description="God Eye Researcher: web app on CloudFront, proxying the AgentCore gateways")

cdk.Tags.of(app).add("project", "god-eye-researcher")
app.synth()
