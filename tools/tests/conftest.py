import importlib
import json
import os
import sys
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "tools" / "src"

os.environ.update({
    "AWS_DEFAULT_REGION": "us-west-2",
    "AWS_REGION": "us-west-2",
    "AWS_ACCESS_KEY_ID": "testing",
    "AWS_SECRET_ACCESS_KEY": "testing",
    "TABLE_NAME": "research",
    "BUCKET_NAME": "research-bucket-test",
    "EVENTS_HTTP_DOMAIN": "",
})
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


@pytest.fixture()
def aws(monkeypatch):
    with mock_aws():
        ddb = boto3.client("dynamodb")
        ddb.create_table(
            TableName="research",
            KeySchema=[{"AttributeName": "PK", "KeyType": "HASH"}, {"AttributeName": "SK", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "PK", "AttributeType": "S"}, {"AttributeName": "SK", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        boto3.client("s3").create_bucket(Bucket="research-bucket-test", CreateBucketConfiguration={"LocationConstraint": "us-west-2"})
        iam = boto3.client("iam")
        role = iam.create_role(RoleName="sfn", AssumeRolePolicyDocument=json.dumps({"Version": "2012-10-17", "Statement": []}))
        sm = boto3.client("stepfunctions").create_state_machine(
            name="cleanup", roleArn=role["Role"]["Arn"],
            definition=json.dumps({"StartAt": "Done", "States": {"Done": {"Type": "Succeed"}}}),
        )
        monkeypatch.setenv("CLEANUP_STATE_MACHINE_ARN", sm["stateMachineArn"])

        # Import the tool modules inside the mock so their module-level clients are mocked.
        mods = {}
        for name in ["common.store", "common.appsync", "common.toolkit", "common.validate", "common.sources", "common.providers",
                     "common.notify", "data_tools", "project_tools", "web_tools", "cleanup", "interceptor"]:
            mods[name] = importlib.reload(importlib.import_module(name))
        published = []

        def fake_publish(project_id, events):
            built = [mods["common.appsync"].make_event(t, project_id, d) for t, d in events]
            published.extend(built)
            return built

        for mod in ("data_tools", "project_tools", "web_tools", "cleanup"):
            monkeypatch.setattr(mods[mod].appsync, "publish", fake_publish)
        yield {"mods": mods, "published": published}
