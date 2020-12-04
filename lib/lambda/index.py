import boto3
import os

ttl = 120 # seconds

hosted_zone_id = os.environ['HOSTED_ZONE_ID']
domain_name = os.environ['DOMAIN_NAME']

ec2 = boto3.client('ec2')
r53 = boto3.client('route53')

def handler(event, context):
    instance = ec2.Instance(event['event']['EC2InstanceId'])
    r53.change_resource_record_sets(
        HostedZoneId=hosted_zone_id,
        ChangeBatch={
            'Comment': 'Updating',
            'Changes': [
                {
                    'Action': 'UPSERT',
                    'ResourceRecordSet': {
                        'Name': domain_name,
                        'Type': 'A',
                        'TTL': ttl,
                        'ResourceRecords': [
                            {
                                'Value': instance.public_ip_address,
                            }
                        ]
                    }
                }
            ]
        }
    )
