import * as pulumi from "@pulumi/pulumi";
import * as awsx from "@pulumi/awsx";
import * as aws from "@pulumi/aws";

// define the default vpc info to deploy

const airtekvpc = new awsx.ec2.Vpc("airtek-vpc", {
    cidrBlock : "10.0.0.0/16",
    subnets: [ 
        {type: "public"},
        {type: "private"},
    ],
    numberOfAvailabilityZones: 2, 
    tags: { "Name": "airtek-vpc"}
});

const cluster = new awsx.ecs.Cluster("cluster", {vpc: airtekvpc, name: "Cluster"});
const webRepo = new awsx.ecr.Repository("web-repo");
const apiRepo = new awsx.ecr.Repository("api-repo");

//const
const infraPrivateDnsNamespace = new aws.servicediscovery.PrivateDnsNamespace("airtekPrivateDnsNamespace", {
    name: "airtek",
    description: "airtek",
    vpc: airtekvpc.id,
});
const infrawebService = new aws.servicediscovery.Service("infraweb", {
    name: "infraweb",
    dnsConfig: {
        namespaceId: infraPrivateDnsNamespace.id,
        dnsRecords: [{
            ttl: 10,
            type: "A",
        }],
        routingPolicy: "MULTIVALUE",
    },
    healthCheckCustomConfig: {
        failureThreshold: 1,
    },
});

const infraapiService = new aws.servicediscovery.Service("infraapi", {
    name: "infraapi",
    dnsConfig: {
        namespaceId: infraPrivateDnsNamespace.id,
        dnsRecords: [{
            ttl: 10,
            type: "A",
        }],
        routingPolicy: "MULTIVALUE",
    },
    healthCheckCustomConfig: {
        failureThreshold: 1,
    },
});

//Alb
const alb = new awsx.elasticloadbalancingv2.ApplicationLoadBalancer(
    "app-lb", { external: true, securityGroups: cluster.securityGroups });
const atg = alb.createTargetGroup(
    "app-tg", { port: 5000, protocol: "HTTP", deregistrationDelay: 0 });
const web = atg.createListener("web", { port: 80 });


const apiImage = apiRepo.buildAndPushImage({
    context: "./infra-team-test/", 
   dockerfile: "./infra-team-test/infra-api/Dockerfile",})
                                                    
const infraapi = new awsx.ecs.FargateService("infraapi", {
    cluster,
    subnets: airtekvpc.publicSubnetIds,
    taskDefinitionArgs: {
        containers: {
            infraapi: {
                image: apiImage,
                portMappings: [ {containerPort: 5000,} ],
            },
        },
    },
    desiredCount: 1,
    
    serviceRegistries: {
        registryArn: infraapiService.arn,
        containerName: "infraapi",
    },
});

const webImage = webRepo.buildAndPushImage({
    context: "./infra-team-test/", 
   dockerfile: "./infra-team-test/infra-web/Dockerfile",})
   
const infraweb = new awsx.ecs.FargateService("infraweb", {
    subnets: airtekvpc.publicSubnetIds,
    cluster,
    taskDefinitionArgs: {
        containers: {
            infraweb: {
                image: webImage,
                portMappings: [ {containerPort: 5000} ],
                environment: [
                {
                    name: "ApiAddress",
                    value: "http://infraapi.airtek:5000/WeatherForecast"
                }],
            },
        },
    },
    desiredCount: 1,
    serviceRegistries: {
        registryArn: infrawebService.arn,
        containerName: "infraweb",
    },
},// { dependsOn: [infraapi], }
);


export const url = pulumi.interpolate`${web.endpoint.hostname}`;
