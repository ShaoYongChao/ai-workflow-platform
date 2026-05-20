# Neo4j 配置目录

如需自定义 Neo4j 配置，在此目录创建 neo4j.conf 并在 docker-compose.yml 中挂载：
```yaml
volumes:
  - ./infra/neo4j/neo4j.conf:/conf/neo4j.conf:ro
```

常见自定义项：
- dbms.memory.heap.max_size=2G
- dbms.connector.bolt.listen_address=:7687
