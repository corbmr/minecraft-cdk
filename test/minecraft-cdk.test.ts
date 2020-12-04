import { expect as expectCDK, countResources } from '@aws-cdk/assert';
import { InstanceClass, InstanceSize, InstanceType } from '@aws-cdk/aws-ec2';
import * as cdk from '@aws-cdk/core';
import { MinecraftCdkStack } from '../lib/index';

/*
 * Example test 
 */
test('SNS Topic Created', () => {
  const app = new cdk.App();
  // WHEN
  const stack = new MinecraftCdkStack(app, 'MyTestConstruct', {
    instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MEDIUM)
  })
  // THEN
  expectCDK(stack).to(countResources('AWS::ECS::Cluster', 1));
});
