import React from 'react';

const JobProgressColumn = ({ jobs }) => {
    return (
        <div className="job-progress-column">
            <h3>Job Progress</h3>
            <table className="job-list-ui-table">
                <thead>
                    <tr>
                        <th>Job</th>
                        <th>Status</th>
                        <th>Submitted</th>
                    </tr>
                </thead>
                <tbody>
                    {jobs.map((job, index) => (
                        <tr key={job.jobId} className={job.status.toLowerCase()}>
                            <td>Job #{index + 1}</td>
                            <td><span className={`job-list-ui-badge ${job.status.toLowerCase()}`}>{job.status}</span></td>
                            <td>{new Date(job.createdAt).toLocaleTimeString()}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

export default JobProgressColumn;
