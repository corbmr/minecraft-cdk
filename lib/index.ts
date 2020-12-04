import * as cdk from '@aws-cdk/core';

export interface MinecraftCdkProps {
  // Define construct properties here
}

export class MinecraftCdk extends cdk.Construct {

  constructor(scope: cdk.Construct, id: string, props: MinecraftCdkProps = {}) {
    super(scope, id);

    // Define construct contents here
  }
}
