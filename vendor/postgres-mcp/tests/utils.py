import logging
import os
import time
from pathlib import Path
from typing import Generator
from typing import Tuple

import docker
import pytest
from docker import errors as docker_errors

logger = logging.getLogger(__name__)


def create_postgres_container(version: str) -> Generator[Tuple[str, str], None, None]:
    """Create a PostgreSQL container of specified version and return its connection string."""
    try:
        client = docker.from_env()
        client.ping()
    except (docker_errors.DockerException, ConnectionError):
        pytest.skip("Docker is not available")

    # Extract PostgreSQL version number
    pg_version = version.split(":")[1] if ":" in version else version

    # Define custom image name with HypoPG
    custom_image_name = f"postgres-hypopg:{pg_version}"

    container_name = f"postgres-crystal-test-{version.replace(':', '_')}-{os.urandom(4).hex()}"
    current_dir = Path(__file__).parent.absolute()

    logger.info(f"Setting up PostgreSQL {pg_version} with HypoPG")

    # Build custom Docker image with HypoPG if it doesn't exist
    try:
        # Check if custom image already exists
        client.images.get(custom_image_name)
        logger.info(f"Using existing Docker image: {custom_image_name}")
    except docker_errors.ImageNotFound:
        # Build the custom image
        logger.info(f"Building custom Docker image: {custom_image_name}")
        try:
            dockerfile_path = current_dir / "Dockerfile.postgres-hypopg"
            if not dockerfile_path.exists():
                logger.error(f"Dockerfile not found at {dockerfile_path}")
                pytest.skip(f"Required Dockerfile not found: {dockerfile_path}")

            # Build the image
            client.images.build(
                path=str(current_dir),
                dockerfile="Dockerfile.postgres-hypopg",
                buildargs={"PG_VERSION": pg_version, "PG_MAJOR": pg_version},
                tag=custom_image_name,
                rm=True,
            )
            logger.info(f"Successfully built image {custom_image_name}")
        except Exception as e:
            logger.error(f"Failed to build Docker image: {e}")
            pytest.skip(f"Failed to build Docker image: {e}")

    postgres_password = "test_password"
    postgres_db = "test_db"

    # Create container with more verbose logging
    container = client.containers.run(
        custom_image_name,
        name=container_name,
        environment={
            "POSTGRES_PASSWORD": postgres_password,
            "POSTGRES_DB": postgres_db,
            "POSTGRES_HOST_AUTH_METHOD": "trust",  # Make authentication easier in tests
        },
        ports={"5432/tcp": ("127.0.0.1", 0)},  # Let Docker assign a random port
        command=[
            "-c",
            "shared_preload_libraries=pg_stat_statements",
            "-c",
            "pg_stat_statements.track=all",
            "-c",
            "log_min_messages=info",  # More verbose logging
            "-c",
            "log_statement=all",  # Log all SQL statements
        ],
        detach=True,
    )

    logger.info(f"Container {container_name} started, waiting for PostgreSQL to be ready")

    try:
        # Wait for container to start and get logs
        time.sleep(2)  # Give container a moment to start
        container.reload()

        # Check if container is running
        if container.status != "running":
            logs = container.logs().decode("utf-8")
            logger.error(f"Container {container_name} failed to start. Logs:\n{logs}")
            pytest.skip(f"PostgreSQL container failed to start: {logs[:500]}...")

        # Get assigned port
        port = container.ports["5432/tcp"][0]["HostPort"]

        # Wait for PostgreSQL to be ready
        deadline = time.time() + 60  # Increased timeout to 60 seconds
        is_ready = False
        last_error = None

        while time.time() < deadline and not is_ready:
            try:
                exit_code, output = container.exec_run("pg_isready")
                if exit_code == 0:
                    logger.info(f"PostgreSQL in container {container_name} is ready")
                    is_ready = True
                    break
                else:
                    last_error = output.decode("utf-8")
                    logger.warning(f"PostgreSQL not ready yet: {last_error}")
            except Exception as e:
                last_error = str(e)
                logger.warning(f"Error checking if PostgreSQL is ready: {e}")

            # Get container logs for debugging
            if time.time() - deadline + 60 > 50:  # Log when we're close to timeout
                logs = container.logs().decode("utf-8")
                logger.warning(f"Still waiting for PostgreSQL. Container logs:\n{logs[-2000:]}")

            time.sleep(2)

        if not is_ready:
            logs = container.logs().decode("utf-8")
            logger.error(f"Timeout waiting for PostgreSQL. Container logs:\n{logs[-2000:]}")
            pytest.skip(f"Timeout waiting for PostgreSQL to start: {last_error}")

        connection_string = f"postgresql://postgres:{postgres_password}@localhost:{port}/{postgres_db}"
        logger.info(f"PostgreSQL connection string: {connection_string}")

        yield connection_string, version

    except Exception as e:
        logger.error(f"Error setting up PostgreSQL container: {e}")
        # Get container logs for debugging
        try:
            logs = container.logs().decode("utf-8")
            logger.error(f"Container logs:\n{logs}")
        except Exception:
            pass
        raise

    finally:
        logger.info(f"Stopping and removing container {container_name}")
        try:
            container.stop(timeout=1)
            container.remove(v=True)
        except Exception as e:
            logger.warning(f"Error cleaning up container {container_name}: {e}")
