
import boto3

print("Creating SQS queues...", flush=True)

sqs = boto3.client(
    "sqs",
    region_name="us-east-1",
    endpoint_url="http://localhost:4566",
    aws_access_key_id="test",
    aws_secret_access_key="test",
)

response = sqs.create_queue(
    QueueName="wager-transactions"
)

print(
    f"SQS queue created: {response['QueueUrl']}",
    flush=True,
)

print("SQS queues created successfully.", flush=True)
